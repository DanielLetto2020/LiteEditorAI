// LiteEditor — модуль «Задачи» 2.0:
//   • Вкладки: «Проект», «Общие», «Сегодня» (фокус дня по проектам), «Календарь».
//   • Quick-Add с парсингом inline-токенов (!1/!2, #тег, @завтра 15:00, *).
//   • Виды: компактный список (плотность Компактно/Карточки) и Канбан 2.0 (опц. «На проверке», WIP-лимит, DnD внутри колонок).
//   • Неблокирующий выдвижной Inspector Drawer справа вместо модалки (автосохранение, теги, срок, подзадачи с DnD, Markdown).
//   • Мультивыбор, Undo-тосты (Ctrl+Z), архив выполненных, экспорт JSON/Markdown, Помодоро и шорткаты.
import {
  el, icon, iconBtn, makeModal, toast, applyLayoutSwap,
  menuRow, placeMenu, placeMenuBelow, closeMenus,
} from '../ui.js';
import { marked } from 'marked';
import { createAgendaView } from './notes-agenda.js';
import { t } from '../i18n.js';
import {
  GLOBAL_ID, STATUSES, STATUS_LABEL, PRIO_LABEL, BUILTIN_TEMPLATES,
  genId, titleOf, bodyOf, joinTitleBody, cleanTag, tagColorIndex,
  normalizeNote, parseQuickInput, dueState, formatDueShort,
  toLocalDateInput, toLocalDateTimeInput, startOfDay, isSameLocalDay,
  computeSnooze, notesToMarkdown, formatNoteForTerminal,
} from './notes-model.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

const KANBAN_GROW = 400;
const DEFAULT_TECH = {
  id: 'classic', name: 'Классическая', work: 25, short: 5, long: 15,
  cyclesBeforeLong: 4, block: true, allowSkip: true, builtin: true,
};

const readErr = (v) => (v && !Array.isArray(v) && typeof v === 'object' && v.error ? String(v.error) : null);
const escAttr = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function mdToSafeHtml(src) {
  const div = el('div', 'nt-md');
  div.setAttribute('data-no-i18n', '');
  const tpl = document.createElement('template');
  try {
    tpl.innerHTML = marked.parse(src || '', { breaks: true });
  } catch (_) {
    div.textContent = src || '';
    return div;
  }
  tpl.content.querySelectorAll('script, style, iframe, frame, object, embed, base, link, meta, form').forEach((n) => n.remove());
  tpl.content.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) {
      const nm = a.name.toLowerCase();
      if (nm.startsWith('on')) n.removeAttribute(a.name);
      else if (/^(href|src|xlink:href)$/.test(nm) && /^(javascript|vbscript):/i.test(a.value.replace(/[\s-]/g, ''))) n.removeAttribute(a.name);
    }
  });
  div.replaceChildren(...tpl.content.childNodes);
  div.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a && /^https?:/i.test(a.href)) { e.preventDefault(); lite.openExternal(a.href); }
  });
  return div;
}

export function initNotes(host) {
  const {
    settings, saveSettings, sendNoteToTerminal,
    layout, GUTTER, saveUiState, refitActiveTerminal, activeProject, closeOtherPanels, getProjects,
  } = host;

  let notesOpen = false;
  let tab = ['project', 'global', 'today', 'calendar'].includes(settings.notesTab) ? settings.notesTab : 'project';
  let filter = 'active'; // 'active' | 'doing' | 'review' | 'done' | 'all' | 'archived'
  let view = settings.notesView === 'kanban' ? 'kanban' : 'list';
  let density = settings.notesDensity === 'cards' ? 'cards' : 'compact';
  let sortMode = ['manual', 'prio', 'due'].includes(settings.notesSort) ? settings.notesSort : 'manual';
  let mdPreview = !!settings.notesMd;
  let reviewCol = settings.notesReviewCol !== false;
  let wipLimit = Number.isFinite(Number(settings.notesWipLimit)) ? Math.max(0, Number(settings.notesWipLimit)) : 3;
  let autoDoing = settings.notesAutoDoing !== false;
  let todayScope = settings.notesTodayScope === 'project' ? 'project' : 'all';

  let query = '';
  let tagFilter = '';
  let notes = [];
  let loadedId = null;
  let loadSeq = 0;
  let kanbanWidened = false;

  let selectedId = null;
  let inspectorId = null;
  let inspectorListId = null;
  let inspectorDescPreview = false;
  let lastFocusedField = null;
  const multiSel = new Set();
  const expanded = new Set();
  const cardEls = new Map();

  let dragId = null;
  let dragSubIdx = -1;
  const undoStack = [];
  let activePomo = null; // { listId, noteId }
  let todayLoading = false;
  let todayFeed = null;

  function activeStatuses() {
    return reviewCol ? ['todo', 'doing', 'review', 'done'] : ['todo', 'doing', 'done'];
  }

  function currentTarget() {
    if (tab === 'global') return { kind: 'global', id: GLOBAL_ID, name: 'Общие заметки' };
    const p = activeProject();
    return p ? { kind: 'project', id: p.id, name: p.name, proj: p } : null;
  }

  function termProject(target) {
    return target && target.kind === 'project' ? target.proj : activeProject();
  }

  function broadcastChange(id) {
    try { lite.app.notesChanged(id); } catch (_) {}
  }

  // ---------------- Помодоро-подписка ----------------
  if (lite && lite.pomodoro && typeof lite.pomodoro.onLogChanged === 'function') {
    lite.pomodoro.onLogChanged(async () => {
      if (!activePomo) return;
      const { listId, noteId } = activePomo;
      try {
        if (loadedId === listId) {
          const cur = notes.find((n) => n.id === noteId);
          if (cur) {
            cur.pomoCount = (cur.pomoCount || 0) + 1;
            save();
            patchOrRedrawCard(cur);
            if (inspectorId === cur.id) renderInspector();
          }
        } else {
          const arr = await lite.store.notesGet(listId);
          if (!readErr(arr) && Array.isArray(arr)) {
            const norm = arr.map(normalizeNote);
            const cur = norm.find((n) => n.id === noteId);
            if (cur) {
              cur.pomoCount = (cur.pomoCount || 0) + 1;
              await lite.store.notesSet(listId, norm);
              broadcastChange(listId);
            }
          }
        }
      } catch (_) {}
    });
  }

  async function startPomodoroForNote(note, listId) {
    if (!lite || !lite.pomodoro) {
      toast('Модуль Помодоро недоступен', { kind: 'err' });
      return;
    }
    const tech = {
      ...DEFAULT_TECH,
      name: titleOf(note.text) || DEFAULT_TECH.name,
    };
    try {
      const r = await lite.pomodoro.start(tech);
      if (r && r.ok === false) {
        toast(t('Не удалось запустить Помодоро: {0}', r.error || ''), { kind: 'err' });
        return;
      }
      activePomo = { listId: listId || loadedId, noteId: note.id };
      toast(t('Помодоро запущен: {0}', titleOf(note.text) || t('(без названия)')), { kind: 'ok' });
    } catch (e) {
      toast(t('Не удалось запустить Помодоро: {0}', (e && e.message) || e), { kind: 'err' });
    }
  }

  // ---------------- мост в Календарь ----------------
  const agenda = createAgendaView({
    activeProject,
    sendNoteToTerminal,
    applyLayoutSwap,
    settings,
    saveSettings,
    getDueTasks: async (targetId) => {
      if (loadedId === targetId) return notes.filter((n) => !n.archived && n.dueAt);
      const arr = await lite.store.notesGet(targetId);
      if (readErr(arr) || !Array.isArray(arr)) return [];
      return arr.map(normalizeNote).filter((n) => !n.archived && n.dueAt);
    },
    toggleDueTask: async (targetId, taskId) => {
      if (loadedId === targetId) {
        const cur = notes.find((n) => n.id === taskId);
        if (!cur) return;
        toggleDoneState(cur);
        save();
        return;
      }
      const arr = await lite.store.notesGet(targetId);
      if (readErr(arr) || !Array.isArray(arr)) return;
      const norm = arr.map(normalizeNote);
      const cur = norm.find((n) => n.id === taskId);
      if (!cur) return;
      toggleDoneState(cur);
      await lite.store.notesSet(targetId, norm);
      broadcastChange(targetId);
    },
    openDueTask: async (targetId, taskId) => {
      const nextTab = targetId === GLOBAL_ID ? 'global' : 'project';
      tab = nextTab;
      settings.notesTab = nextTab;
      saveSettings();
      loadedId = null;
      await renderPanel();
      if (notes.some((n) => n.id === taskId)) {
        selectedId = taskId;
        inspectorId = taskId;
        inspectorListId = loadedId;
        renderList();
      }
    },
  });

  // ---------------- данные ----------------
  async function load(id) {
    const seq = ++loadSeq;
    const raw = await lite.store.notesGet(id);
    if (seq !== loadSeq) return false;
    const err = readErr(raw);
    if (err) {
      notes = [];
      loadedId = null;
      toast(t('Не прочитать список задач: {0} — он не изменится, пока файл не прочитается', err), { kind: 'err', ttl: 9000 });
      return true;
    }
    const arr = Array.isArray(raw) ? raw : [];
    notes = arr.filter((n) => n && typeof n === 'object').map(normalizeNote);
    loadedId = id;
    return true;
  }

  function save() {
    if (!loadedId) return;
    lite.store.notesSet(loadedId, notes);
    broadcastChange(loadedId);
  }

  function pushUndo(label, snapshotArr, listId = loadedId) {
    if (!listId) return;
    undoStack.push({
      listId,
      label,
      snapshot: JSON.parse(JSON.stringify(snapshotArr)),
    });
    if (undoStack.length > 20) undoStack.shift();
  }

  async function undoLast() {
    const entry = undoStack.pop();
    if (!entry) { toast('Нечего отменять'); return; }
    if (loadedId === entry.listId) {
      notes = entry.snapshot.map(normalizeNote);
      save();
      renderList();
    } else {
      await lite.store.notesSet(entry.listId, entry.snapshot);
      broadcastChange(entry.listId);
    }
    toast('Действие отменено', { kind: 'ok' });
  }

  function counts() {
    let active = 0, doing = 0, review = 0, done = 0, archived = 0, all = 0;
    for (const n of notes) {
      if (n.archived) { archived++; continue; }
      all++;
      if (n.status === 'done') done++;
      else active++;
      if (n.status === 'doing') doing++;
      else if (n.status === 'review') review++;
    }
    return { active, doing, review, done, all, archived };
  }

  function allTagsWithCounts() {
    const map = new Map();
    for (const n of notes) {
      if (n.archived) continue;
      for (const tg of (n.tags || [])) map.set(tg, (map.get(tg) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  function matchesFilter(n) {
    if (filter === 'archived') return !!n.archived;
    if (n.archived) return false;
    if (filter === 'active') return n.status !== 'done';
    if (filter === 'doing') return n.status === 'doing';
    if (filter === 'review') return n.status === 'review';
    if (filter === 'done') return n.status === 'done';
    return true;
  }

  function matchesQuery(n) {
    if (tagFilter && !(n.tags || []).includes(tagFilter)) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    if ((n.text || '').toLowerCase().includes(q)) return true;
    if ((n.tags || []).some((tg) => tg.toLowerCase().includes(q))) return true;
    return Array.isArray(n.subtasks) && n.subtasks.some((s) => (s.text || '').toLowerCase().includes(q));
  }

  function sortArray(arr) {
    if (sortMode === 'prio') return arr.slice().sort((a, b) => b.prio - a.prio);
    if (sortMode === 'due') {
      return arr.slice().sort((a, b) => {
        const ta = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
        const tb = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
        if (ta !== tb) return ta - tb;
        return b.prio - a.prio;
      });
    }
    return arr;
  }

  function visible() {
    return sortArray(notes.filter((n) => matchesFilter(n) && matchesQuery(n)));
  }

  function toggleDoneState(note) {
    if (note.archived) {
      note.archived = false;
      note.status = note.prevStatus || 'todo';
      note.prevStatus = null;
      note.archivedAt = null;
      note.doneAt = null;
      return;
    }
    if (note.status === 'done') {
      note.status = 'todo';
      note.doneAt = null;
    } else {
      note.status = 'done';
      note.doneAt = new Date().toISOString();
    }
  }

  function setStatus(note, nextStatus) {
    if (!STATUSES.includes(nextStatus)) return;
    if (note.archived) {
      note.archived = false;
      note.prevStatus = null;
      note.archivedAt = null;
    }
    note.status = nextStatus;
    note.doneAt = nextStatus === 'done' ? (note.doneAt || new Date().toISOString()) : null;
  }

  function archiveNote(note) {
    if (note.archived) {
      note.archived = false;
      note.status = note.prevStatus || 'todo';
      note.prevStatus = null;
      note.archivedAt = null;
      note.doneAt = null;
      save();
      renderList();
      toast('Возвращено из архива');
      return;
    }
    pushUndo(t('Задача отправлена в архив'), notes);
    note.prevStatus = note.status !== 'done' ? note.status : 'todo';
    note.status = 'done'; // инвариант для countActiveNotes в ядре
    note.archived = true;
    note.archivedAt = new Date().toISOString();
    if (!note.doneAt) note.doneAt = note.archivedAt;
    if (inspectorId === note.id) closeInspector();
    save();
    renderList();
    toast('В архиве', { actionLabel: 'Отменить', action: undoLast, ttl: 6000 });
  }

  function deleteNoteInstant(note) {
    const ix = notes.indexOf(note);
    if (ix < 0) return;
    pushUndo(t('Задача удалена'), notes);
    notes.splice(ix, 1);
    multiSel.delete(note.id);
    if (selectedId === note.id) selectedId = null;
    if (inspectorId === note.id) closeInspector();
    save();
    renderList();
    toast('Задача удалена', { actionLabel: 'Отменить', action: undoLast, ttl: 6000 });
  }

  function move(note, dir) {
    const vis = visible();
    const sib = vis[vis.indexOf(note) + dir];
    if (!sib) return;
    const a = notes.indexOf(note), b = notes.indexOf(sib);
    if (a < 0 || b < 0) return;
    [notes[a], notes[b]] = [notes[b], notes[a]];
    save();
    renderBody();
  }

  function reorderList(srcId, dstId, after) {
    const si = notes.findIndex((n) => n.id === srcId);
    if (si < 0) return;
    const [m] = notes.splice(si, 1);
    const di = notes.findIndex((n) => n.id === dstId);
    if (di < 0) { notes.splice(si, 0, m); return; }
    notes.splice(after ? di + 1 : di, 0, m);
    save();
    renderBody();
  }

  function reorderKanban(srcId, dstId, after, targetStatus) {
    const si = notes.findIndex((n) => n.id === srcId);
    if (si < 0) return;
    const [m] = notes.splice(si, 1);
    if (targetStatus && STATUSES.includes(targetStatus)) setStatus(m, targetStatus);
    if (dstId) {
      const di = notes.findIndex((n) => n.id === dstId);
      if (di >= 0) {
        notes.splice(after ? di + 1 : di, 0, m);
        save();
        updateChips();
        renderBody();
        return;
      }
    }
    notes.push(m);
    save();
    updateChips();
    renderBody();
  }

  // ---------------- создание задач ----------------
  function createTaskFromQuick(rawText, { openInsp = false, forcedStatus = 'todo' } = {}) {
    if (!loadedId) {
      toast('Список задач ещё не загрузился', { kind: 'err' });
      return null;
    }
    const parsed = parseQuickInput(rawText, new Date(), t);
    if (!parsed.text && !openInsp) return null;
    const n = normalizeNote({
      id: genId('n'),
      text: parsed.text,
      status: forcedStatus,
      prio: parsed.prio,
      tags: parsed.tags,
      dueAt: parsed.dueAt,
      allDay: parsed.allDay,
      today: parsed.today,
      subtasks: [],
      createdAt: new Date().toISOString(),
    });
    notes.unshift(n);
    if (filter === 'done' || filter === 'archived') filter = 'active';
    save();
    selectedId = n.id;
    if (openInsp) {
      inspectorId = n.id;
      inspectorListId = loadedId;
      inspectorDescPreview = false;
    }
    renderList();
    if (openInsp) {
      setTimeout(() => {
        const ti = $('.nt-insp-title');
        if (ti) ti.focus();
      }, 20);
    }
    return n;
  }

  function createTaskFromTemplate(tpl) {
    if (!loadedId) { toast('Откройте проект или вкладку «Общие»'); return; }
    const n = normalizeNote({
      id: genId('n'),
      text: t(tpl.text),
      status: 'todo',
      prio: tpl.prio || 0,
      tags: tpl.tags || [],
      subtasks: (tpl.subtasks || []).map((s) => ({ id: genId('s'), text: t(s), done: false })),
      createdAt: new Date().toISOString(),
    });
    notes.unshift(n);
    if (filter === 'done' || filter === 'archived') filter = 'active';
    save();
    selectedId = n.id;
    inspectorId = n.id;
    inspectorListId = loadedId;
    inspectorDescPreview = false;
    renderList();
    setTimeout(() => {
      const ti = $('.nt-insp-title');
      if (ti) { ti.focus(); ti.setSelectionRange(ti.value.length, ti.value.length); }
    }, 20);
  }

  // ---------------- выпадающие меню ----------------
  function openMenuWithOwner(ownerKey, buildFn, anchorOrCoords) {
    const ml = $('#menu-layer');
    const wasSame = Boolean(ml && ml.firstChild && ml.dataset.owner === ownerKey);
    closeMenus();
    if (ml) ml.dataset.owner = ownerKey;
    if (wasSame) {
      if (ml) delete ml.dataset.owner;
      return;
    }
    const dd = el('div', 'menu-dropdown nt-menu');
    buildFn(dd);
    if (Array.isArray(anchorOrCoords)) placeMenu(dd, anchorOrCoords[0], anchorOrCoords[1]);
    else placeMenuBelow(dd, anchorOrCoords);
  }

  function openSortMenu(anchor) {
    openMenuWithOwner('sort', (dd) => {
      const mk = (mode, label) => menuRow(
        sortMode === mode ? 'check' : '',
        label,
        () => { setSort(mode); },
        sortMode === mode ? 'mopen' : '',
      );
      dd.append(
        mk('manual', 'Вручную'),
        mk('prio', 'По важности'),
        mk('due', 'По сроку'),
      );
    }, anchor);
  }

  function openTemplateMenu(anchor) {
    openMenuWithOwner('tpl', (dd) => {
      dd.appendChild(el('div', 'menu-label', 'Шаблоны задач'));
      for (const tpl of BUILTIN_TEMPLATES) {
        dd.appendChild(menuRow('wand', tpl.name, () => createTaskFromTemplate(tpl)));
      }
    }, anchor);
  }

  function openOverflowMenu(anchor) {
    const c = counts();
    openMenuWithOwner('more', (dd) => {
      dd.append(
        menuRow('file-text', 'Markdown-превью', () => {
          mdPreview = !mdPreview;
          settings.notesMd = mdPreview;
          saveSettings();
          renderList();
        }, mdPreview ? 'mopen' : ''),
        menuRow('columns', 'Колонка «На проверке»', () => {
          reviewCol = !reviewCol;
          settings.notesReviewCol = reviewCol;
          saveSettings();
          if (!reviewCol && filter === 'review') filter = 'active';
          renderList();
        }, reviewCol ? 'mopen' : ''),
        menuRow('terminal', 'Авто-статус «В работе» при отправке', () => {
          autoDoing = !autoDoing;
          settings.notesAutoDoing = autoDoing;
          saveSettings();
        }, autoDoing ? 'mopen' : ''),
        menuRow('sliders', 'Лимит колонки «В работе» (WIP)', (e) => {
          e.stopPropagation();
          const cycle = [0, 2, 3, 5];
          const ix = cycle.indexOf(wipLimit);
          wipLimit = cycle[(ix + 1) % cycle.length];
          settings.notesWipLimit = wipLimit;
          saveSettings();
          renderBody();
          closeMenus();
        }, '', { badge: wipLimit > 0 ? String(wipLimit) : t('Выкл') }),
        el('div', 'menu-sep'),
        menuRow('wand', 'Создать из шаблона…', (e) => {
          e.stopPropagation();
          openTemplateMenu(anchor);
        }),
      );
      if (c.done > 0) {
        dd.append(menuRow('archive', t('В архив выполненные ({0})', c.done), () => archiveDone()));
      }
      dd.append(
        el('div', 'menu-sep'),
        menuRow('download', 'Экспорт (JSON / Markdown)', () => exportMenu()),
        menuRow('upload', 'Импорт из JSON', () => importNotes()),
        menuRow('keyboard', 'Горячие клавиши', () => openShortcutsModal(), '', { kbd: '?' }),
      );
    }, anchor);
  }

  function openStatusPicker(note, x, y) {
    openMenuWithOwner('status:' + note.id, (dd) => {
      for (const st of activeStatuses()) {
        dd.appendChild(menuRow(
          note.status === st ? 'check' : '',
          STATUS_LABEL[st],
          () => { setStatus(note, st); afterMutate(note); },
          note.status === st ? 'mopen' : '',
        ));
      }
    }, [x, y]);
  }

  function openCardMenu(note, x, y) {
    const target = currentTarget();
    const toGlobal = target && target.kind === 'project';
    openMenuWithOwner('card:' + note.id, (dd) => {
      dd.append(
        menuRow('eye', 'Открыть детали', () => openInspector(note.id), '', { kbd: 'Enter' }),
        menuRow('terminal', 'В терминал', () => sendToTerminal(note, target, false), '', { kbd: 'Ctrl+Enter' }),
        menuRow('terminal', 'В терминал и удалить', () => sendToTerminal(note, target, true)),
        el('div', 'menu-sep'),
      );
      for (const st of activeStatuses()) {
        dd.appendChild(menuRow(
          note.status === st ? 'check' : '',
          STATUS_LABEL[st],
          () => { setStatus(note, st); afterMutate(note); },
          note.status === st ? 'mopen' : '',
        ));
      }
      dd.append(el('div', 'menu-sep'));
      for (let p = 0; p < 3; p++) {
        dd.appendChild(menuRow(
          note.prio === p ? 'flag' : '',
          PRIO_LABEL[p],
          () => { note.prio = p; afterMutate(note); },
          note.prio === p ? 'mopen' : '',
        ));
      }
      dd.append(
        el('div', 'menu-sep'),
        menuRow('star', note.today ? 'Убрать из фокуса «Сегодня»' : 'В фокус «Сегодня»', () => {
          note.today = !note.today;
          afterMutate(note);
        }, '', { kbd: 'T' }),
      );
      if (lite && lite.pomodoro) {
        dd.append(menuRow('clock', 'Запустить Помодоро', () => startPomodoroForNote(note, loadedId)));
      }
      dd.append(
        menuRow(toGlobal ? 'globe' : 'folder', toGlobal ? 'Перенести в «Общие»' : 'Перенести в проект', () => moveToOtherList(note, target)),
        menuRow('copy', 'Копировать текст', () => copyText(note)),
        menuRow('plus', 'Дублировать', () => duplicateNote(note)),
        menuRow(note.archived ? 'corner-up-left' : 'archive', note.archived ? 'Вернуть из архива' : 'В архив', () => archiveNote(note)),
        menuRow('trash', 'Удалить', () => deleteNoteInstant(note), 'danger', { kbd: 'Del' }),
      );
    }, [x, y]);
  }

  function duplicateNote(note) {
    const copy = normalizeNote({
      ...note,
      id: genId('n'),
      archived: false,
      prevStatus: null,
      archivedAt: null,
      createdAt: new Date().toISOString(),
      doneAt: null,
      pomoCount: 0,
      subtasks: (note.subtasks || []).map((s) => ({ id: genId('s'), text: s.text, done: false })),
    });
    const ix = notes.indexOf(note);
    notes.splice(ix >= 0 ? ix + 1 : 0, 0, copy);
    save();
    renderList();
    toast('Задача дублирована');
  }

  // ---------------- рендер: shell ----------------
  const TABS = [
    ['project', 'Проект', 'folder'],
    ['global', 'Общие', 'globe'],
    ['today', 'Сегодня', 'star'],
    ['calendar', 'Календарь', 'clock'],
  ];

  function renderTabsSeg() {
    const seg = el('div', 'nt-seg');
    for (const [k, label, icName] of TABS) {
      const b = el('button', 'nt-seg-btn' + (tab === k ? ' on' : ''));
      b.type = 'button';
      b.dataset.tab = k;
      b.append(icon(icName, 14), el('span', null, label));
      b.addEventListener('click', () => switchTab(k));
      seg.appendChild(b);
    }
    return seg;
  }

  function renderList() {
    const body = $('#notes-body');
    if (!body) return;
    const title = $('#notes-proj');

    if (tab === 'calendar') {
      if (title) title.textContent = t('Календарь напоминаний');
      body.replaceChildren();
      const top = el('div', 'nt-topbar');
      top.appendChild(renderTabsSeg());
      const agRoot = el('div', 'ag-root');
      agRoot.dataset.agenda = '1';
      body.append(top, agRoot);
      agenda.render(agRoot);
      return;
    }

    if (tab === 'today') {
      if (title) title.textContent = t('Сегодня — фокус дня');
      renderTodayShell(body);
      return;
    }

    const target = currentTarget();
    if (title) {
      title.textContent = tab === 'global'
        ? t('Общие заметки')
        : (target ? t('Задачи — {0}', target.name) : t('Задачи проекта'));
    }

    body.replaceChildren();

    // 1. Topbar
    const top = el('div', 'nt-topbar');
    top.appendChild(renderTabsSeg());

    const topTools = el('div', 'nt-toptools');
    const viewSeg = el('div', 'nt-seg sm');
    const mkView = (m, ic, ttl) => {
      const b = el('button', 'nt-seg-btn' + (view === m ? ' on' : ''));
      b.type = 'button';
      b.title = ttl;
      b.appendChild(icon(ic, 14));
      b.addEventListener('click', () => setView(m));
      return b;
    };
    viewSeg.append(
      mkView('list', 'list', 'Список (B)'),
      mkView('kanban', 'columns', 'Канбан (B)'),
    );
    topTools.appendChild(viewSeg);

    if (view === 'list') {
      const densBtn = el('button', 'nt-tbtn');
      densBtn.type = 'button';
      densBtn.appendChild(icon(density === 'compact' ? 'unfold' : 'fold', 14));
      densBtn.title = density === 'compact' ? 'Плотность: компактно (клик — карточки)' : 'Плотность: карточки (клик — компактно)';
      densBtn.addEventListener('click', () => {
        density = density === 'compact' ? 'cards' : 'compact';
        settings.notesDensity = density;
        saveSettings();
        renderList();
      });
      topTools.appendChild(densBtn);
    }

    const sortBtn = el('button', 'nt-tbtn' + (sortMode !== 'manual' ? ' on' : ''));
    sortBtn.type = 'button';
    sortBtn.appendChild(icon('obs-sort', 14));
    sortBtn.title = sortMode === 'prio' ? 'Сортировка: по важности' : sortMode === 'due' ? 'Сортировка: по сроку' : 'Сортировка: вручную';
    sortBtn.addEventListener('click', (e) => { e.stopPropagation(); openSortMenu(sortBtn); });
    topTools.appendChild(sortBtn);

    const moreBtn = el('button', 'nt-tbtn');
    moreBtn.type = 'button';
    moreBtn.appendChild(icon('dots-h', 15));
    moreBtn.title = 'Настройки и действия';
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); openOverflowMenu(moreBtn); });
    topTools.appendChild(moreBtn);

    top.appendChild(topTools);
    body.appendChild(top);

    if (!target) {
      const empty = el('div', 'nt-empty', 'Откройте проект слева, чтобы вести его задачи. Либо переключитесь на вкладку «Общие» или «Сегодня».');
      body.appendChild(empty);
      return;
    }

    // 2. Smart Quick-Add
    const qWrap = el('div', 'nt-quick-wrap');
    const qBar = el('div', 'nt-quick');
    const qIc = el('span', 'nt-qic');
    qIc.appendChild(icon('plus', 15));
    const qIn = el('input', 'nt-qinput');
    qIn.type = 'text';
    qIn.dataset.quick = '1';
    qIn.placeholder = 'Новая задача… !2 #тег @завтра 15:00 *  (Enter / Shift+Enter)';
    qIn.spellcheck = false;

    const qTpl = iconBtn('nt-qbtn', 'wand', 'Создать из шаблона', 14);
    qTpl.type = 'button';
    qTpl.addEventListener('click', (e) => { e.stopPropagation(); openTemplateMenu(qTpl); });

    const qOpenInsp = iconBtn('nt-qbtn', 'pencil', 'Создать и открыть в инспекторе (Shift+Enter)', 14);
    qOpenInsp.type = 'button';
    qOpenInsp.addEventListener('click', () => {
      const val = qIn.value;
      qIn.value = '';
      updateQuickPreview('');
      createTaskFromQuick(val, { openInsp: true });
    });

    qBar.append(qIc, qIn, qTpl, qOpenInsp);

    const qPrev = el('div', 'nt-qpreview hidden');
    const updateQuickPreview = (val) => {
      if (!val || !val.trim()) { qPrev.classList.add('hidden'); qPrev.replaceChildren(); return; }
      const parsed = parseQuickInput(val, new Date(), t);
      if (!parsed.tokens.length) { qPrev.classList.add('hidden'); qPrev.replaceChildren(); return; }
      qPrev.replaceChildren();
      for (const tok of parsed.tokens) {
        if (tok.kind === 'prio') {
          const ch = el('span', 'nt-qpchip pr-' + tok.prio, tok.label);
          qPrev.appendChild(ch);
        } else if (tok.kind === 'today') {
          const ch = el('span', 'nt-qpchip is-today');
          ch.append(icon('star', 11), el('span', null, tok.label));
          qPrev.appendChild(ch);
        } else if (tok.kind === 'due') {
          const ch = el('span', 'nt-qpchip is-due');
          ch.append(icon('clock', 11), el('span', null, tok.label));
          qPrev.appendChild(ch);
        } else if (tok.kind === 'tag') {
          const ch = el('span', `nt-tag nt-tag-c${tagColorIndex(tok.tag)}`, tok.label);
          ch.setAttribute('data-no-i18n', '');
          qPrev.appendChild(ch);
        }
      }
      qPrev.classList.remove('hidden');
    };
    qIn.addEventListener('input', () => updateQuickPreview(qIn.value));
    qIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        const val = qIn.value;
        qIn.value = '';
        updateQuickPreview('');
        createTaskFromQuick(val, { openInsp: true });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const val = qIn.value.trim();
        if (!val) return;
        qIn.value = '';
        updateQuickPreview('');
        createTaskFromQuick(val, { openInsp: false });
        setTimeout(() => { const elQ = $('[data-quick]'); if (elQ) elQ.focus(); }, 0);
      } else if (e.key === 'Escape') {
        if (qIn.value) { qIn.value = ''; updateQuickPreview(''); }
        else qIn.blur();
      }
    });
    qWrap.append(qBar, qPrev);
    body.appendChild(qWrap);

    // 3. Filters: search + status chips + tag bar
    const filters = el('div', 'nt-filters');

    const sBox = el('div', 'nt-searchbox');
    sBox.appendChild(icon('search', 14));
    const sIn = el('input', 'nt-search');
    sIn.type = 'text';
    sIn.dataset.search = '1';
    sIn.placeholder = 'Поиск по задачам, тегам, подзадачам… (/)';
    sIn.value = query;
    const sClr = iconBtn('nt-sclr' + (query ? '' : ' hidden'), 'x', 'Очистить поиск', 13);
    sClr.type = 'button';
    sIn.addEventListener('input', () => {
      query = sIn.value.trim();
      sClr.classList.toggle('hidden', !query);
      renderBody();
    });
    sIn.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (sIn.value) { sIn.value = ''; query = ''; sClr.classList.add('hidden'); renderBody(); }
        sIn.blur();
      }
    });
    sClr.addEventListener('click', () => {
      sIn.value = '';
      query = '';
      sClr.classList.add('hidden');
      renderBody();
      sIn.focus();
    });
    sBox.append(sIn, sClr);
    filters.appendChild(sBox);

    const c = counts();
    const chips = el('div', 'nt-chips');
    if (view === 'list' || filter === 'archived') {
      const chipDefs = [
        ['active', 'Активные', c.active],
        ['doing', 'В работе', c.doing],
        ...(reviewCol || c.review > 0 ? [['review', 'На проверке', c.review]] : []),
        ['done', 'Готово', c.done],
        ['all', 'Все', c.all],
        ...(c.archived > 0 || filter === 'archived' ? [['archived', 'Архив', c.archived]] : []),
      ];
      for (const [fk, flbl, fcnt] of chipDefs) {
        const ch = el('button', 'nt-chip' + (filter === fk ? ' active' : ''));
        ch.type = 'button';
        ch.dataset.f = fk;
        ch.append(el('span', null, flbl), el('span', 'nt-cnt', fcnt ? String(fcnt) : ''));
        ch.addEventListener('click', () => {
          filter = fk;
          renderList();
        });
        chips.appendChild(ch);
      }
      filters.appendChild(chips);
    } else if (c.archived > 0) {
      const archBtn = el('button', 'nt-chip');
      archBtn.type = 'button';
      archBtn.dataset.f = 'archived';
      archBtn.append(icon('archive', 12), el('span', null, 'Архив'), el('span', 'nt-cnt', String(c.archived)));
      archBtn.addEventListener('click', () => { filter = 'archived'; renderList(); });
      chips.appendChild(archBtn);
      filters.appendChild(chips);
    }

    const tags = allTagsWithCounts();
    if (tags.length) {
      const tBar = el('div', 'nt-tagbar');
      for (const [tg, cnt] of tags) {
        const b = el('button', `nt-tag nt-tag-c${tagColorIndex(tg)}${tagFilter === tg ? ' active' : ''}`);
        b.type = 'button';
        b.setAttribute('data-no-i18n', '');
        b.textContent = `#${tg} ${cnt}`;
        b.addEventListener('click', () => {
          tagFilter = tagFilter === tg ? '' : tg;
          renderList();
        });
        tBar.appendChild(b);
      }
      if (tagFilter) {
        const rst = el('button', 'nt-tag-reset', 'Сбросить');
        rst.type = 'button';
        rst.addEventListener('click', () => { tagFilter = ''; renderList(); });
        tBar.appendChild(rst);
      }
      filters.appendChild(tBar);
    }

    body.appendChild(filters);

    // 4. Workspace = Main (List/Kanban + Bulkbar) + Inspector Drawer
    const ws = el('div', 'nt-workspace' + (inspectorId ? ' has-insp' : ''));
    const main = el('div', 'nt-main');
    const listElBox = el('div', 'nt-list');
    listElBox.dataset.list = '1';
    const bulk = el('div', 'nt-bulkbar' + (multiSel.size ? '' : ' hidden'));
    bulk.dataset.bulk = '1';
    main.append(listElBox, bulk);

    const backdrop = el('div', 'nt-insp-backdrop');
    backdrop.addEventListener('click', () => closeInspector());
    const insp = el('aside', 'nt-inspector' + (inspectorId ? '' : ' hidden'));
    insp.dataset.inspector = '1';

    ws.append(main, backdrop, insp);
    body.appendChild(ws);

    renderBody();
    renderBulkBar();
    renderInspector();
  }

  // ---------------- тело: список или канбан ----------------
  function listEl() { return $('[data-list]'); }

  function emptyMsg() {
    if (query || tagFilter) return 'Ничего не найдено по текущему фильтру.';
    if (filter === 'archived') return 'Архив пуст.';
    if (filter === 'done') return 'Выполненных задач пока нет.';
    if (filter === 'doing') return 'Нет задач в работе.';
    if (filter === 'review') return 'Нет задач на проверке.';
    if (filter === 'active') return 'Активных задач нет — добавьте новую строкой выше.';
    return 'Пусто — добавьте первую задачу строкой выше.';
  }

  function renderBody() {
    const list = listEl();
    if (!list) return;
    const sc = list.scrollTop;
    cardEls.clear();
    list.replaceChildren();
    const isKanbanMode = view === 'kanban' && filter !== 'archived';
    list.classList.toggle('nt-kanban', isKanbanMode);
    if (isKanbanMode) renderKanban(list);
    else renderListView(list);
    list.scrollTop = sc;
    requestAnimationFrame(() => list.querySelectorAll('.nt-card').forEach(clampCard));
  }

  function renderListView(list) {
    const rows = visible();
    if (!rows.length) {
      list.appendChild(el('div', 'nt-empty', emptyMsg()));
      return;
    }
    rows.forEach((note) => list.appendChild(buildCard(note, rows, false)));
  }

  function renderKanban(list) {
    const cols = activeStatuses();
    for (const status of cols) {
      let items = notes.filter((n) => !n.archived && n.status === status && matchesQuery(n));
      items = sortArray(items);

      const overWip = status === 'doing' && wipLimit > 0 && items.length > wipLimit;
      const colWrap = el('div', 'nt-col st-' + status + (overWip ? ' wip-over' : ''));
      const head = el('div', 'nt-col-head');
      const dot = el('span', 'nt-col-dot st-' + status);
      const ttl = el('span', 'nt-col-title', STATUS_LABEL[status]);
      const cntTxt = status === 'doing' && wipLimit > 0 ? `${items.length}/${wipLimit}` : String(items.length);
      const cnt = el('span', 'nt-col-cnt', cntTxt);
      if (status === 'doing') {
        cnt.title = 'Лимит WIP (клик — сменить: Выкл / 2 / 3 / 5)';
        cnt.style.cursor = 'pointer';
        cnt.addEventListener('click', () => {
          const cycle = [0, 2, 3, 5];
          wipLimit = cycle[(cycle.indexOf(wipLimit) + 1) % cycle.length];
          settings.notesWipLimit = wipLimit;
          saveSettings();
          renderBody();
        });
      }
      head.append(dot, ttl, el('span', 'nt-spacer'), cnt);
      colWrap.appendChild(head);

      const colBody = el('div', 'nt-col-body');
      colBody.dataset.col = status;
      attachKanbanDrop(colBody, status);
      items.forEach((note) => colBody.appendChild(buildCard(note, items, true)));
      if (!items.length) colBody.appendChild(el('div', 'nt-col-empty', 'Перетащите сюда'));
      colWrap.appendChild(colBody);

      // Быстрое добавление внизу колонки
      const colFoot = el('div', 'nt-col-foot');
      const addColBtn = el('button', 'nt-col-add', '＋ Добавить');
      addColBtn.type = 'button';
      addColBtn.addEventListener('click', () => {
        const inp = el('input', 'nt-col-input');
        inp.type = 'text';
        inp.placeholder = 'Новая задача… (Enter)';
        colFoot.replaceChildren(inp);
        inp.focus();
        let committed = false;
        const finish = (saveIt) => {
          if (committed) return;
          committed = true;
          const val = inp.value.trim();
          if (saveIt && val) createTaskFromQuick(val, { forcedStatus: status });
          else renderBody();
        };
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); finish(true); }
          else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        inp.addEventListener('blur', () => finish(false));
      });
      colFoot.appendChild(addColBtn);
      colWrap.appendChild(colFoot);

      list.appendChild(colWrap);
    }
  }

  function afterMutate(note) {
    save();
    updateChips();
    const isKanban = view === 'kanban' && filter !== 'archived';
    if (isKanban || sortMode !== 'manual') {
      renderBody();
    } else {
      const shown = matchesFilter(note) && matchesQuery(note);
      const old = cardEls.get(note.id);
      if (!shown) {
        if (old) old.remove();
        cardEls.delete(note.id);
        ensureEmptyState();
      } else {
        const fresh = buildCard(note, visible(), false);
        if (old) old.replaceWith(fresh);
        else listEl() && listEl().appendChild(fresh);
        clampCard(fresh);
      }
    }
    if (inspectorId === note.id) renderInspector();
  }

  function patchOrRedrawCard(note) {
    const old = cardEls.get(note.id);
    if (!old) return;
    const isKanban = view === 'kanban' && filter !== 'archived';
    const fresh = buildCard(note, isKanban ? notes.filter((n) => n.status === note.status) : visible(), isKanban);
    old.replaceWith(fresh);
    clampCard(fresh);
  }

  function ensureEmptyState() {
    if (view === 'kanban' && filter !== 'archived') return;
    const list = listEl();
    if (!list) return;
    if (!list.querySelector('.nt-card') && !list.querySelector('.nt-empty')) {
      list.appendChild(el('div', 'nt-empty', emptyMsg()));
    }
  }

  function updateChips() {
    const c = counts();
    const map = { active: c.active, doing: c.doing, review: c.review, done: c.done, all: c.all, archived: c.archived };
    document.querySelectorAll('.nt-chip').forEach((ch) => {
      const cnt = ch.querySelector('.nt-cnt');
      if (cnt && ch.dataset.f) cnt.textContent = map[ch.dataset.f] ? String(map[ch.dataset.f]) : '';
    });
  }

  // ---------------- карточка задачи ----------------
  function buildCard(note, vis, isKanban) {
    const compact = !isKanban && density === 'compact';
    const isDone = note.status === 'done';
    const cls = [
      'nt-card',
      'st-' + note.status,
      'pr-' + note.prio,
      isDone ? 'done' : '',
      note.archived ? 'archived' : '',
      compact ? 'compact' : '',
      selectedId === note.id ? 'selected' : '',
      multiSel.has(note.id) ? 'multi' : '',
    ].filter(Boolean).join(' ');

    const card = el('div', cls);
    card.dataset.id = note.id;
    attachDnD(card, note, isKanban);

    const top = el('div', 'nt-top');

    // Статус-кнопка
    const stBtn = el('button', 'nt-stbtn st-' + note.status);
    stBtn.type = 'button';
    stBtn.title = t('Статус: {0} (клик — дальше, ПКМ — выбрать)', t(STATUS_LABEL[note.status] || note.status));
    if (isDone) stBtn.appendChild(icon('check', 12));
    stBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (note.archived) { archiveNote(note); return; }
      const cycle = activeStatuses();
      const idx = cycle.indexOf(note.status);
      const next = cycle[(idx + 1) % cycle.length];
      setStatus(note, next);
      afterMutate(note);
    });
    stBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openStatusPicker(note, e.clientX, e.clientY);
    });

    const colEl = el('div', 'nt-textcol');

    // Заголовок (+ звезда фокуса если active)
    const titleRow = el('div', 'nt-title-row');
    if (note.today) {
      const stIc = el('span', 'nt-today-star');
      stIc.appendChild(icon('star', 12));
      stIc.title = 'В фокусе сегодня';
      titleRow.appendChild(stIc);
    }
    const titleEl = el('div', 'nt-title', titleOf(note.text) || t('(пусто)'));
    titleEl.setAttribute('data-no-i18n', '');
    titleRow.appendChild(titleEl);
    colEl.appendChild(titleRow);

    // Тело задачи (только в cards/kanban)
    const bt = bodyOf(note.text);
    if (bt && !compact) {
      const isExp = expanded.has(note.id);
      const bodyEl = el('div', 'nt-body' + (isExp ? '' : ' clip'));
      bodyEl.setAttribute('data-no-i18n', '');
      if (mdPreview) bodyEl.appendChild(mdToSafeHtml(bt));
      else bodyEl.textContent = bt;
      colEl.appendChild(bodyEl);
      const expBtn = el('button', 'nt-expand');
      expBtn.type = 'button';
      const sync = () => { expBtn.textContent = bodyEl.classList.contains('clip') ? t('Развернуть ⌄') : t('Свернуть ⌃'); };
      sync();
      expBtn.style.display = 'none';
      expBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const clip = bodyEl.classList.toggle('clip');
        if (clip) expanded.delete(note.id);
        else expanded.add(note.id);
        sync();
      });
      colEl.appendChild(expBtn);
      card._clipBody = bodyEl;
      card._clipBtn = expBtn;
    }

    // Бейджи (срок, приоритет, теги, прогресс подзадач, помодоро, заметка)
    const badges = el('div', 'nt-badges');
    let hasBadge = false;

    if (note.prio > 0) {
      hasBadge = true;
      const pf = el('button', 'nt-badge-prio pr-' + note.prio);
      pf.type = 'button';
      pf.title = 'Приоритет (клик — сменить)';
      pf.append(icon('flag', 11), el('span', null, PRIO_LABEL[note.prio]));
      pf.addEventListener('click', (e) => {
        e.stopPropagation();
        note.prio = (note.prio + 1) % 3;
        afterMutate(note);
      });
      badges.appendChild(pf);
    }

    if (note.dueAt) {
      hasBadge = true;
      const ds = dueState(note.dueAt, note.allDay, isDone, new Date()) || 'later';
      const db = el('span', 'nt-due ds-' + ds);
      db.append(icon('clock', 11), el('span', null, formatDueShort(note.dueAt, note.allDay, new Date(), t)));
      badges.appendChild(db);
    }

    if (Array.isArray(note.subtasks) && note.subtasks.length) {
      hasBadge = true;
      const doneN = note.subtasks.filter((s) => s.done).length;
      const totalN = note.subtasks.length;
      const sp = el('span', 'nt-subprog' + (doneN === totalN ? ' all' : ''));
      sp.append(el('span', null, `${doneN}/${totalN}`));
      const bar = el('span', 'nt-subbar');
      const fill = el('span', 'nt-subfill');
      fill.style.width = `${Math.round((doneN / totalN) * 100)}%`;
      bar.appendChild(fill);
      sp.appendChild(bar);
      badges.appendChild(sp);
    }

    if (note.pomoCount > 0) {
      hasBadge = true;
      const pm = el('span', 'nt-pomo-badge');
      pm.append(icon('clock', 11), el('span', null, String(note.pomoCount)));
      pm.title = t('Завершено помодоро: {0}', note.pomoCount);
      badges.appendChild(pm);
    }

    if (compact && bt) {
      hasBadge = true;
      const bi = el('span', 'nt-body-ic');
      bi.appendChild(icon('file-text', 11));
      bi.title = 'Есть описание';
      badges.appendChild(bi);
    }

    if (Array.isArray(note.tags) && note.tags.length) {
      hasBadge = true;
      for (const tg of note.tags) {
        const chip = el('button', `nt-tag nt-tag-c${tagColorIndex(tg)}`, '#' + tg);
        chip.type = 'button';
        chip.setAttribute('data-no-i18n', '');
        chip.title = t('Фильтр по тегу #{0}', tg);
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          tagFilter = tagFilter === tg ? '' : tg;
          renderList();
        });
        badges.appendChild(chip);
      }
    }

    if (hasBadge) colEl.appendChild(badges);

    // Подзадачи чеклистом — в режиме cards
    if (!compact && !isKanban && Array.isArray(note.subtasks) && note.subtasks.length) {
      const sub = el('div', 'nt-subs');
      note.subtasks.forEach((s) => {
        const row = el('div', 'nt-sub' + (s.done ? ' done' : ''));
        const cb = el('button', 'nt-sub-cb' + (s.done ? ' on' : ''));
        cb.type = 'button';
        if (s.done) cb.appendChild(icon('check', 10));
        cb.addEventListener('click', (e) => {
          e.stopPropagation();
          s.done = !s.done;
          afterMutate(note);
        });
        const txt = el('span', 'nt-sub-txt', s.text);
        txt.setAttribute('data-no-i18n', '');
        row.append(cb, txt);
        sub.appendChild(row);
      });
      colEl.appendChild(sub);
    }

    // Hover-панель быстрых действий
    const hActs = el('div', 'nt-hacts');
    const target = currentTarget();
    const sendBtn = iconBtn('nt-act accent', 'terminal', 'В терминал (Ctrl+Enter)', 14);
    sendBtn.type = 'button';
    sendBtn.addEventListener('click', (e) => { e.stopPropagation(); sendToTerminal(note, target, false); });

    const starBtn = iconBtn('nt-act' + (note.today ? ' star-on' : ''), 'star', note.today ? 'Убрать из «Сегодня»' : 'В фокус «Сегодня» (T)', 14);
    starBtn.type = 'button';
    starBtn.addEventListener('click', (e) => { e.stopPropagation(); note.today = !note.today; afterMutate(note); });

    const menuBtn = iconBtn('nt-act', 'dots-h', 'Действия', 14);
    menuBtn.type = 'button';
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = menuBtn.getBoundingClientRect();
      openCardMenu(note, r.right, r.bottom + 4);
    });

    const delBtn = iconBtn('nt-act danger', 'trash', 'Удалить (Del)', 14);
    delBtn.type = 'button';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteNoteInstant(note); });

    hActs.append(sendBtn, starBtn, menuBtn, delBtn);

    top.append(stBtn, colEl, hActs);
    card.appendChild(top);

    // Стрелки вверх/вниз в ручной сортировке (компактно по клику или клавишами)
    if (!isKanban && sortMode === 'manual' && !query && !tagFilter && vis.length > 1) {
      const vi = vis.indexOf(note);
      const up = iconBtn('nt-act', 'chevron-up', 'Выше', 13);
      up.type = 'button';
      up.disabled = vi <= 0;
      up.addEventListener('click', (e) => { e.stopPropagation(); move(note, -1); });
      const dn = iconBtn('nt-act', 'chevron-down', 'Ниже', 13);
      dn.type = 'button';
      dn.disabled = vi >= vis.length - 1;
      dn.addEventListener('click', (e) => { e.stopPropagation(); move(note, 1); });
      hActs.prepend(up, dn);
    }

    card.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input')) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        if (multiSel.has(note.id)) multiSel.delete(note.id);
        else multiSel.add(note.id);
        card.classList.toggle('multi', multiSel.has(note.id));
        renderBulkBar();
        return;
      }
      selectCard(note.id, { openInsp: true });
    });

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCardMenu(note, e.clientX, e.clientY);
    });

    cardEls.set(note.id, card);
    return card;
  }

  function clampCard(card) {
    const body = card._clipBody, btn = card._clipBtn;
    if (!body || !btn) return;
    const wasClip = body.classList.contains('clip');
    body.classList.add('clip');
    const overflow = body.scrollHeight > body.clientHeight + 2;
    if (!wasClip) body.classList.remove('clip');
    btn.style.display = overflow ? '' : 'none';
  }

  function selectCard(id, { openInsp = false } = {}) {
    if (selectedId && cardEls.get(selectedId)) cardEls.get(selectedId).classList.remove('selected');
    selectedId = id;
    const nextEl = id ? cardEls.get(id) : null;
    if (nextEl) {
      nextEl.classList.add('selected');
      nextEl.scrollIntoView({ block: 'nearest' });
    }
    if (openInsp && id) openInspector(id);
  }

  // ---------------- Bulkbar (мультивыбор) ----------------
  function renderBulkBar() {
    const bar = $('[data-bulk]');
    if (!bar) return;
    if (!multiSel.size) { bar.classList.add('hidden'); bar.replaceChildren(); return; }
    bar.classList.remove('hidden');
    bar.replaceChildren();

    bar.appendChild(el('span', 'nt-bulk-cnt', t('Выбрано: {0}', multiSel.size)));

    const selectedNotes = () => notes.filter((n) => multiSel.has(n.id));

    const stBtn = el('button', 'nt-bulk-btn', 'Статус ▾');
    stBtn.type = 'button';
    stBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenuWithOwner('bulk-status', (dd) => {
        for (const st of activeStatuses()) {
          dd.appendChild(menuRow('', STATUS_LABEL[st], () => {
            for (const n of selectedNotes()) setStatus(n, st);
            save();
            renderList();
          }));
        }
      }, stBtn);
    });

    const prBtn = el('button', 'nt-bulk-btn', 'Приоритет ▾');
    prBtn.type = 'button';
    prBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenuWithOwner('bulk-prio', (dd) => {
        for (let p = 0; p < 3; p++) {
          dd.appendChild(menuRow('flag', PRIO_LABEL[p], () => {
            for (const n of selectedNotes()) n.prio = p;
            save();
            renderList();
          }));
        }
      }, prBtn);
    });

    const todBtn = el('button', 'nt-bulk-btn', '★ Сегодня');
    todBtn.type = 'button';
    todBtn.addEventListener('click', () => {
      const list = selectedNotes();
      const allOn = list.every((n) => n.today);
      for (const n of list) n.today = !allOn;
      save();
      renderList();
    });

    const archBtn = el('button', 'nt-bulk-btn', 'В архив');
    archBtn.type = 'button';
    archBtn.addEventListener('click', () => {
      const list = selectedNotes();
      if (!list.length) return;
      pushUndo(t('Задачи отправлены в архив'), notes);
      const ts = new Date().toISOString();
      for (const n of list) {
        if (!n.archived) {
          n.prevStatus = n.status !== 'done' ? n.status : 'todo';
          n.status = 'done';
          n.archived = true;
          n.archivedAt = ts;
          if (!n.doneAt) n.doneAt = ts;
        }
      }
      multiSel.clear();
      closeInspector();
      save();
      renderList();
      toast(t('Отправлено в архив: {0}', list.length), { actionLabel: 'Отменить', action: undoLast, ttl: 6000 });
    });

    const delBtn = el('button', 'nt-bulk-btn danger', 'Удалить');
    delBtn.type = 'button';
    delBtn.addEventListener('click', () => {
      const count = multiSel.size;
      if (!count) return;
      pushUndo(t('Удалено задач: {0}', count), notes);
      notes = notes.filter((n) => !multiSel.has(n.id));
      multiSel.clear();
      if (inspectorId && !notes.some((n) => n.id === inspectorId)) closeInspector();
      save();
      renderList();
      toast(t('Удалено задач: {0}', count), { actionLabel: 'Отменить', action: undoLast, ttl: 6000 });
    });

    const clrBtn = iconBtn('nt-act', 'x', 'Снять выделение', 14);
    clrBtn.type = 'button';
    clrBtn.addEventListener('click', () => { multiSel.clear(); renderList(); });

    bar.append(stBtn, prBtn, todBtn, archBtn, delBtn, el('span', 'nt-spacer'), clrBtn);
  }

  // ---------------- DnD ----------------
  function attachDnD(card, note, isKanban) {
    const canDrag = isKanban || (view === 'list' && sortMode === 'manual' && !query && !tagFilter && filter !== 'archived');
    if (!canDrag) return;
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      dragId = note.id;
      card.classList.add('nt-dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', note.id); } catch (_) {}
    });
    card.addEventListener('dragend', () => {
      dragId = null;
      card.classList.remove('nt-dragging');
      clearDropMarks();
    });
    card.addEventListener('dragover', (e) => {
      if (!dragId || dragId === note.id) return;
      e.preventDefault();
      e.stopPropagation();
      const after = e.clientY > card.getBoundingClientRect().top + card.offsetHeight / 2;
      markDrop(card, after);
    });
    card.addEventListener('dragleave', () => card.classList.remove('nt-drop-before', 'nt-drop-after'));
    card.addEventListener('drop', (e) => {
      if (!dragId || dragId === note.id) return;
      e.preventDefault();
      e.stopPropagation();
      const after = e.clientY > card.getBoundingClientRect().top + card.offsetHeight / 2;
      const src = dragId;
      dragId = null;
      clearDropMarks();
      if (isKanban) reorderKanban(src, note.id, after, note.status);
      else reorderList(src, note.id, after);
    });
  }

  function markDrop(card, after) {
    clearDropMarks();
    card.classList.add(after ? 'nt-drop-after' : 'nt-drop-before');
  }

  function clearDropMarks() {
    document.querySelectorAll('.nt-drop-before, .nt-drop-after').forEach((n) => n.classList.remove('nt-drop-before', 'nt-drop-after'));
    document.querySelectorAll('.nt-col-over').forEach((n) => n.classList.remove('nt-col-over'));
  }

  function attachKanbanDrop(colBody, status) {
    colBody.addEventListener('dragover', (e) => {
      if (!dragId) return;
      e.preventDefault();
      colBody.classList.add('nt-col-over');
    });
    colBody.addEventListener('dragleave', (e) => {
      if (!colBody.contains(e.relatedTarget)) colBody.classList.remove('nt-col-over');
    });
    colBody.addEventListener('drop', (e) => {
      if (!dragId) return;
      e.preventDefault();
      const src = dragId;
      dragId = null;
      clearDropMarks();
      reorderKanban(src, null, true, status);
    });
  }

  // ---------------- Inspector Drawer ----------------
  function openInspector(id) {
    inspectorId = id;
    inspectorListId = loadedId;
    inspectorDescPreview = false;
    const ws = $('.nt-workspace');
    if (ws) ws.classList.add('has-insp');
    renderInspector();
  }

  function closeInspector() {
    inspectorId = null;
    inspectorListId = null;
    const ws = $('.nt-workspace');
    if (ws) ws.classList.remove('has-insp');
    const insp = $('[data-inspector]');
    if (insp) { insp.classList.add('hidden'); insp.replaceChildren(); }
  }

  function renderInspector() {
    const insp = $('[data-inspector]');
    if (!insp) return;
    if (!inspectorId || inspectorListId !== loadedId) {
      insp.classList.add('hidden');
      insp.replaceChildren();
      const ws = $('.nt-workspace');
      if (ws) ws.classList.remove('has-insp');
      return;
    }
    const note = notes.find((n) => n.id === inspectorId);
    if (!note) {
      closeInspector();
      return;
    }
    insp.classList.remove('hidden');
    insp.replaceChildren();

    const target = currentTarget();

    // 1. Шапка инспектора
    const head = el('div', 'nt-insp-head');
    const stPill = el('button', 'nt-insp-st st-' + note.status);
    stPill.type = 'button';
    stPill.append(el('span', 'nt-insp-stdot st-' + note.status), el('span', null, STATUS_LABEL[note.status]));
    stPill.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = stPill.getBoundingClientRect();
      openStatusPicker(note, r.left, r.bottom + 4);
    });

    const starBtn = iconBtn('nt-act' + (note.today ? ' star-on' : ''), 'star', note.today ? 'Убрать из фокуса «Сегодня»' : 'В фокус «Сегодня» (T)', 15);
    starBtn.type = 'button';
    starBtn.addEventListener('click', () => { note.today = !note.today; afterMutate(note); });

    const swapBtn = iconBtn('nt-act', 'swap', 'Раскладка (преобразовать RU/EN)', 15);
    swapBtn.type = 'button';

    const copyBtn = iconBtn('nt-act', 'copy', 'Копировать текст', 15);
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => copyText(note));

    const archBtn = iconBtn('nt-act', note.archived ? 'corner-up-left' : 'archive', note.archived ? 'Вернуть из архива' : 'В архив', 15);
    archBtn.type = 'button';
    archBtn.addEventListener('click', () => archiveNote(note));

    const delBtn = iconBtn('nt-act danger', 'trash', 'Удалить задачу', 15);
    delBtn.type = 'button';
    delBtn.addEventListener('click', () => deleteNoteInstant(note));

    const clsBtn = iconBtn('nt-act', 'x', 'Закрыть детали (Esc)', 15);
    clsBtn.type = 'button';
    clsBtn.addEventListener('click', () => closeInspector());

    head.append(stPill, el('span', 'nt-spacer'), starBtn, swapBtn, copyBtn, archBtn, delBtn, clsBtn);

    // 2. Скроллируемое тело инспектора
    const scroll = el('div', 'nt-insp-scroll');

    const titleInp = el('input', 'nt-insp-title');
    titleInp.type = 'text';
    titleInp.setAttribute('data-no-i18n', '');
    titleInp.placeholder = 'Заголовок задачи…';
    titleInp.value = titleOf(note.text);

    const descTa = el('textarea', 'nt-insp-ta');
    descTa.setAttribute('data-no-i18n', '');
    descTa.placeholder = 'Подробности, ссылки, чеклист, код (Markdown)…';
    descTa.value = bodyOf(note.text);

    lastFocusedField = titleInp;
    titleInp.addEventListener('focus', () => { lastFocusedField = titleInp; });
    descTa.addEventListener('focus', () => { lastFocusedField = descTa; });
    swapBtn.addEventListener('click', () => {
      const fld = (lastFocusedField === descTa) ? descTa : titleInp;
      applyLayoutSwap(fld);
      commitTextFields();
    });

    let saveTimer = null;
    const commitTextFields = () => {
      clearTimeout(saveTimer);
      const nextText = joinTitleBody(titleInp.value, descTa.value);
      if (nextText === note.text) return;
      note.text = nextText;
      save();
      patchOrRedrawCard(note);
    };
    const scheduleTextSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(commitTextFields, 220);
    };
    titleInp.addEventListener('input', scheduleTextSave);
    titleInp.addEventListener('blur', commitTextFields);
    titleInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitTextFields(); descTa.focus(); }
    });
    descTa.addEventListener('input', scheduleTextSave);
    descTa.addEventListener('blur', commitTextFields);
    descTa.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        commitTextFields();
        sendToTerminal(note, target, false);
      }
    });

    scroll.appendChild(titleInp);

    // 3. Паспорт свойств
    const props = el('div', 'nt-insp-props');

    // Приоритет сегментом
    const prRow = el('div', 'nt-prop-row');
    prRow.appendChild(el('span', 'nt-prop-lbl', 'Приоритет'));
    const prSeg = el('div', 'nt-seg sm');
    for (let p = 0; p < 3; p++) {
      const b = el('button', 'nt-seg-btn' + (note.prio === p ? ' on' : ''), PRIO_LABEL[p]);
      b.type = 'button';
      b.addEventListener('click', () => { note.prio = p; afterMutate(note); });
      prSeg.appendChild(b);
    }
    prRow.appendChild(prSeg);
    props.appendChild(prRow);

    // Срок
    const dueRow = el('div', 'nt-prop-row col');
    const dueHead = el('div', 'nt-prop-head');
    dueHead.appendChild(el('span', 'nt-prop-lbl', 'Срок'));
    const allDayLbl = el('label', 'nt-prop-chk');
    const allDayIn = el('input');
    allDayIn.type = 'checkbox';
    allDayIn.checked = !!note.allDay;
    allDayLbl.append(allDayIn, el('span', null, 'Весь день'));
    dueHead.appendChild(allDayLbl);
    dueRow.appendChild(dueHead);

    const dueCtrl = el('div', 'nt-due-ctrl');
    const dueIn = el('input', 'nt-due-input');
    const syncDueType = () => { dueIn.type = allDayIn.checked ? 'date' : 'datetime-local'; };
    syncDueType();
    if (note.dueAt) {
      const d = new Date(note.dueAt);
      dueIn.value = allDayIn.checked ? toLocalDateInput(d) : toLocalDateTimeInput(d);
    }
    const applyDueInput = () => {
      if (!dueIn.value) {
        note.dueAt = null;
        note.allDay = false;
      } else {
        const d = allDayIn.checked ? new Date(dueIn.value + 'T00:00') : new Date(dueIn.value);
        if (!isNaN(d.getTime())) {
          note.dueAt = d.toISOString();
          note.allDay = !!allDayIn.checked;
        }
      }
      afterMutate(note);
    };
    dueIn.addEventListener('change', applyDueInput);
    allDayIn.addEventListener('change', () => {
      const cur = dueIn.value;
      syncDueType();
      if (cur && allDayIn.checked) dueIn.value = cur.slice(0, 10);
      else if (cur && !allDayIn.checked && cur.length === 10) dueIn.value = cur + 'T09:00';
      if (dueIn.value) applyDueInput();
      else { note.allDay = false; save(); }
    });

    const mkQuickDue = (label, days) => {
      const b = el('button', 'nt-mini-pill', label);
      b.type = 'button';
      b.addEventListener('click', () => {
        const d = startOfDay(new Date());
        d.setDate(d.getDate() + days);
        note.dueAt = d.toISOString();
        note.allDay = true;
        if (days === 0) note.today = true;
        afterMutate(note);
      });
      return b;
    };
    const clrDue = iconBtn('nt-act', 'x', 'Убрать срок', 13);
    clrDue.type = 'button';
    clrDue.addEventListener('click', () => { note.dueAt = null; note.allDay = false; afterMutate(note); });

    dueCtrl.append(dueIn, clrDue);
    const dueQuick = el('div', 'nt-due-quick');
    dueQuick.append(mkQuickDue('Сегодня', 0), mkQuickDue('Завтра', 1), mkQuickDue('+7 дней', 7));
    dueRow.append(dueCtrl, dueQuick);
    props.appendChild(dueRow);

    // Теги
    const tagRow = el('div', 'nt-prop-row col');
    tagRow.appendChild(el('span', 'nt-prop-lbl', 'Теги'));
    const tagBox = el('div', 'nt-insp-tags');
    for (const tg of (note.tags || [])) {
      const chip = el('span', `nt-tag nt-tag-c${tagColorIndex(tg)}`);
      chip.setAttribute('data-no-i18n', '');
      chip.append(el('span', null, '#' + tg));
      const rm = el('button', 'nt-tag-x', '×');
      rm.type = 'button';
      rm.addEventListener('click', () => {
        note.tags = note.tags.filter((x) => x !== tg);
        afterMutate(note);
      });
      chip.appendChild(rm);
      tagBox.appendChild(chip);
    }
    const tagIn = el('input', 'nt-tag-add');
    tagIn.type = 'text';
    tagIn.placeholder = '＋ тег…';
    tagIn.setAttribute('list', 'nt-tags-datalist');
    tagIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const tg = cleanTag(tagIn.value);
        if (tg && !note.tags.includes(tg)) {
          note.tags.push(tg);
          tagIn.value = '';
          afterMutate(note);
          setTimeout(() => { const ni = $('.nt-tag-add'); if (ni) ni.focus(); }, 0);
        } else {
          tagIn.value = '';
        }
      }
    });
    tagBox.appendChild(tagIn);

    const dl = el('datalist');
    dl.id = 'nt-tags-datalist';
    for (const [tg] of allTagsWithCounts()) {
      if (!note.tags.includes(tg)) {
        const opt = el('option');
        opt.value = tg;
        dl.appendChild(opt);
      }
    }
    tagRow.append(tagBox, dl);
    props.appendChild(tagRow);

    scroll.appendChild(props);

    // 4. Описание + превью Markdown
    const descSec = el('div', 'nt-insp-sec');
    const descHead = el('div', 'nt-insp-sec-h');
    descHead.appendChild(el('span', 'nt-prop-lbl', 'Описание'));
    const descSeg = el('div', 'nt-seg sm');
    const mkMode = (isPrev, label) => {
      const b = el('button', 'nt-seg-btn' + (inspectorDescPreview === isPrev ? ' on' : ''), label);
      b.type = 'button';
      b.addEventListener('click', () => {
        commitTextFields();
        inspectorDescPreview = isPrev;
        renderInspector();
      });
      return b;
    };
    descSeg.append(mkMode(false, 'Текст'), mkMode(true, 'Превью'));
    descHead.appendChild(descSeg);
    descSec.appendChild(descHead);

    if (inspectorDescPreview) {
      const prev = el('div', 'nt-insp-preview');
      if (bodyOf(note.text)) prev.appendChild(mdToSafeHtml(bodyOf(note.text)));
      else prev.appendChild(el('div', 'nt-insp-empty', 'Описание пока пустое. Кликните, чтобы написать.'));
      prev.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        inspectorDescPreview = false;
        renderInspector();
        setTimeout(() => { const ta = $('.nt-insp-ta'); if (ta) ta.focus(); }, 0);
      });
      descSec.appendChild(prev);
    } else {
      descSec.appendChild(descTa);
    }
    scroll.appendChild(descSec);

    // 5. Подзадачи с DnD и inline-добавлением
    const subSec = el('div', 'nt-insp-sec');
    const subHead = el('div', 'nt-insp-sec-h');
    const doneSubs = note.subtasks.filter((s) => s.done).length;
    subHead.appendChild(el('span', 'nt-prop-lbl', t('Подзадачи ({0}/{1})', doneSubs, note.subtasks.length)));
    subSec.appendChild(subHead);

    if (note.subtasks.length) {
      const pbar = el('div', 'nt-insp-pbar');
      const pfill = el('div', 'nt-insp-pfill');
      pfill.style.width = `${Math.round((doneSubs / note.subtasks.length) * 100)}%`;
      pbar.appendChild(pfill);
      subSec.appendChild(pbar);
    }

    const subList = el('div', 'nt-insp-subs');
    note.subtasks.forEach((s, idx) => {
      const row = el('div', 'nt-insp-sub' + (s.done ? ' done' : ''));
      const grip = el('span', 'nt-sub-grip');
      grip.appendChild(icon('drag-handle', 13));
      grip.draggable = true;
      grip.addEventListener('dragstart', (e) => {
        dragSubIdx = idx;
        row.classList.add('nt-dragging');
        try { e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
      });
      grip.addEventListener('dragend', () => {
        dragSubIdx = -1;
        row.classList.remove('nt-dragging');
      });
      row.addEventListener('dragover', (e) => {
        if (dragSubIdx < 0 || dragSubIdx === idx) return;
        e.preventDefault();
      });
      row.addEventListener('drop', (e) => {
        if (dragSubIdx < 0 || dragSubIdx === idx) return;
        e.preventDefault();
        const [moved] = note.subtasks.splice(dragSubIdx, 1);
        note.subtasks.splice(idx, 0, moved);
        dragSubIdx = -1;
        afterMutate(note);
      });

      const cb = el('button', 'nt-sub-cb' + (s.done ? ' on' : ''));
      cb.type = 'button';
      if (s.done) cb.appendChild(icon('check', 10));
      cb.addEventListener('click', () => { s.done = !s.done; afterMutate(note); });

      const sInp = el('input', 'nt-insp-subin');
      sInp.type = 'text';
      sInp.setAttribute('data-no-i18n', '');
      sInp.value = s.text || '';
      let subT = null;
      sInp.addEventListener('input', () => {
        s.text = sInp.value;
        clearTimeout(subT);
        subT = setTimeout(() => { save(); patchOrRedrawCard(note); }, 250);
      });
      sInp.addEventListener('blur', () => {
        clearTimeout(subT);
        save();
        patchOrRedrawCard(note);
      });

      const rm = iconBtn('nt-act danger', 'x', 'Убрать', 12);
      rm.type = 'button';
      rm.addEventListener('click', () => {
        note.subtasks.splice(idx, 1);
        afterMutate(note);
      });

      row.append(grip, cb, sInp, rm);
      subList.appendChild(row);
    });

    const addSubInp = el('input', 'nt-insp-subadd');
    addSubInp.type = 'text';
    addSubInp.placeholder = '＋ Добавить подзадачу… (Enter)';
    addSubInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const txt = addSubInp.value.trim();
        if (!txt) return;
        note.subtasks.push({ id: genId('s'), text: txt, done: false });
        addSubInp.value = '';
        afterMutate(note);
        setTimeout(() => { const ni = $('.nt-insp-subadd'); if (ni) ni.focus(); }, 0);
      }
    });
    subSec.append(subList, addSubInp);
    scroll.appendChild(subSec);

    // Мета-даты
    const datesMeta = el('div', 'nt-insp-dates');
    if (note.createdAt) datesMeta.appendChild(el('span', null, t('Создана: {0}', new Date(note.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }))));
    if (note.doneAt) datesMeta.appendChild(el('span', null, t('Завершена: {0}', new Date(note.doneAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }))));
    scroll.appendChild(datesMeta);

    // 6. Нижний футер действий
    const foot = el('div', 'nt-insp-foot');
    const send = el('button', 'nt-sendbtn');
    send.type = 'button';
    send.append(icon('terminal', 14), el('span', null, 'В терминал'));
    send.addEventListener('click', () => { commitTextFields(); sendToTerminal(note, target, false); });

    const sendDel = el('button', 'nt-sendbtn');
    sendDel.type = 'button';
    sendDel.append(icon('terminal', 14), el('span', null, '+ удалить'));
    sendDel.addEventListener('click', () => { commitTextFields(); sendToTerminal(note, target, true); });

    foot.append(send, sendDel);

    if (lite && lite.pomodoro) {
      const pomoBtn = el('button', 'nt-sendbtn nt-move');
      pomoBtn.type = 'button';
      pomoBtn.append(icon('clock', 14), el('span', null, note.pomoCount > 0 ? t('Помодоро ({0})', note.pomoCount) : 'Помодоро'));
      pomoBtn.addEventListener('click', () => startPomodoroForNote(note, loadedId));
      foot.appendChild(pomoBtn);
    }

    const toGlobal = target && target.kind === 'project';
    const moveBtn = el('button', 'nt-sendbtn nt-move');
    moveBtn.type = 'button';
    moveBtn.append(icon(toGlobal ? 'globe' : 'folder', 14), el('span', null, toGlobal ? 'В общие' : 'В проект'));
    moveBtn.addEventListener('click', () => { commitTextFields(); moveToOtherList(note, target); });
    foot.appendChild(moveBtn);

    insp.append(head, scroll, foot);
  }

  // ---------------- вкладка «Сегодня / Фокус» ----------------
  async function loadTodayFeed() {
    todayLoading = true;
    const now = new Date();
    const sources = [];
    const curProj = activeProject();
    if (todayScope === 'project') {
      if (curProj) sources.push({ id: curProj.id, name: curProj.name, proj: curProj, kind: 'project' });
      else sources.push({ id: GLOBAL_ID, name: 'Общие', proj: null, kind: 'global' });
    } else {
      for (const p of (getProjects ? getProjects() : [])) {
        sources.push({ id: p.id, name: p.name, proj: p, kind: 'project' });
      }
      sources.push({ id: GLOBAL_ID, name: 'Общие', proj: null, kind: 'global' });
    }

    const overdue = [];
    const todayItems = [];
    const doneToday = [];

    await Promise.all(sources.map(async (src) => {
      try {
        const rawNotes = await lite.store.notesGet(src.id);
        if (!readErr(rawNotes) && Array.isArray(rawNotes)) {
          for (const raw of rawNotes) {
            if (!raw || typeof raw !== 'object') continue;
            const n = normalizeNote(raw);
            if (n.archived) continue;
            const ds = n.dueAt ? dueState(n.dueAt, n.allDay, n.status === 'done', now) : null;
            if (n.status === 'done') {
              if (n.doneAt && isSameLocalDay(n.doneAt, now) && (n.today || isSameLocalDay(n.dueAt, now))) {
                doneToday.push({ kind: 'task', item: n, src });
              }
            } else if (ds === 'overdue') {
              overdue.push({ kind: 'task', item: n, src });
            } else if (n.today || ds === 'today') {
              todayItems.push({ kind: 'task', item: n, src });
            }
          }
        }
      } catch (_) {}

      try {
        const rawAg = await lite.store.agendaGet(src.id);
        if (!readErr(rawAg) && Array.isArray(rawAg)) {
          for (const r of rawAg) {
            if (!r || typeof r !== 'object' || !r.at) continue;
            const at = new Date(r.at);
            if (isNaN(at.getTime())) continue;
            const ds = dueState(r.at, !!r.allDay, !!r.done, now);
            if (r.done) {
              if (isSameLocalDay(r.at, now)) doneToday.push({ kind: 'reminder', item: r, src });
            } else if (ds === 'overdue') {
              overdue.push({ kind: 'reminder', item: r, src });
            } else if (ds === 'today') {
              todayItems.push({ kind: 'reminder', item: r, src });
            }
          }
        }
      } catch (_) {}
    }));

    overdue.sort((a, b) => (new Date(a.item.dueAt || a.item.at || 0).getTime()) - (new Date(b.item.dueAt || b.item.at || 0).getTime()));
    todayItems.sort((a, b) => (b.item.prio || 0) - (a.item.prio || 0));

    todayFeed = { overdue, todayItems, doneToday };
    todayLoading = false;
    if (tab === 'today' && notesOpen) {
      const body = $('#notes-body');
      if (body) renderTodayBody(body);
    }
  }

  function renderTodayShell(body) {
    body.replaceChildren();
    const top = el('div', 'nt-topbar');
    top.appendChild(renderTabsSeg());

    const topTools = el('div', 'nt-toptools');
    const scSeg = el('div', 'nt-seg sm');
    const mkScope = (val, lbl) => {
      const b = el('button', 'nt-seg-btn' + (todayScope === val ? ' on' : ''), lbl);
      b.type = 'button';
      b.addEventListener('click', () => {
        todayScope = val;
        settings.notesTodayScope = val;
        saveSettings();
        loadTodayFeed();
      });
      return b;
    };
    scSeg.append(mkScope('all', 'Все проекты'), mkScope('project', 'Этот проект'));
    const refBtn = iconBtn('nt-tbtn', 'refresh', 'Обновить', 14);
    refBtn.type = 'button';
    refBtn.addEventListener('click', () => loadTodayFeed());
    topTools.append(scSeg, refBtn);
    top.appendChild(topTools);
    body.appendChild(top);

    const wrap = el('div', 'nt-today-wrap');
    wrap.dataset.todayWrap = '1';
    body.appendChild(wrap);

    if (todayFeed && !todayLoading) renderTodayBody(body);
    else {
      wrap.appendChild(el('div', 'nt-empty', 'Собираю задачи на сегодня…'));
      if (!todayLoading) loadTodayFeed();
    }
  }

  function renderTodayBody(body) {
    const wrap = body.querySelector('[data-today-wrap]');
    if (!wrap || !todayFeed) return;
    wrap.replaceChildren();
    const now = new Date();
    const { overdue, todayItems, doneToday } = todayFeed;
    const total = overdue.length + todayItems.length + doneToday.length;

    // Прогресс дня
    const hero = el('div', 'nt-today-hero');
    const heroTop = el('div', 'nt-today-hero-top');
    heroTop.append(
      el('span', 'nt-today-hero-t', 'Фокус дня'),
      el('span', 'nt-today-hero-c', total ? t('Выполнено: {0} из {1}', doneToday.length, total) : 'Нет задач на сегодня'),
    );
    const bar = el('div', 'nt-insp-pbar');
    const fill = el('div', 'nt-insp-pfill');
    fill.style.width = total ? `${Math.round((doneToday.length / total) * 100)}%` : '0%';
    bar.appendChild(fill);
    hero.append(heroTop, bar);
    wrap.appendChild(hero);

    if (!total) {
      wrap.appendChild(el('div', 'nt-empty', 'На сегодня ничего не запланировано. Отметьте важные задачи ★ или поставьте срок @сегодня.'));
      return;
    }

    const list = el('div', 'nt-list');

    const toggleTodayEntry = async (entry) => {
      if (entry.kind === 'task') {
        const arr = await lite.store.notesGet(entry.src.id);
        if (readErr(arr) || !Array.isArray(arr)) return;
        const norm = arr.map(normalizeNote);
        const cur = norm.find((n) => n.id === entry.item.id);
        if (!cur) return;
        toggleDoneState(cur);
        await lite.store.notesSet(entry.src.id, norm);
        broadcastChange(entry.src.id);
      } else {
        const arr = await lite.store.agendaGet(entry.src.id);
        if (readErr(arr) || !Array.isArray(arr)) return;
        const cur = arr.find((r) => r && r.id === entry.item.id);
        if (!cur) return;
        cur.done = !cur.done;
        if (cur.done) cur.notifiedAt = new Date().toISOString();
        await lite.store.agendaSet(entry.src.id, arr);
        try { lite.app.agendaChanged(entry.src.id); } catch (_) {}
      }
      loadTodayFeed();
    };

    const snoozeTodayEntry = async (entry) => {
      const sn = computeSnooze('tomorrow', new Date());
      if (!sn) return;
      if (entry.kind === 'task') {
        const arr = await lite.store.notesGet(entry.src.id);
        if (readErr(arr) || !Array.isArray(arr)) return;
        const norm = arr.map(normalizeNote);
        const cur = norm.find((n) => n.id === entry.item.id);
        if (!cur) return;
        cur.dueAt = sn.at;
        cur.allDay = true;
        cur.today = false;
        await lite.store.notesSet(entry.src.id, norm);
        broadcastChange(entry.src.id);
      } else {
        const arr = await lite.store.agendaGet(entry.src.id);
        if (readErr(arr) || !Array.isArray(arr)) return;
        const cur = arr.find((r) => r && r.id === entry.item.id);
        if (!cur) return;
        cur.at = sn.at;
        cur.allDay = sn.allDay;
        cur.notifiedAt = null;
        await lite.store.agendaSet(entry.src.id, arr);
        try { lite.app.agendaChanged(entry.src.id); } catch (_) {}
      }
      toast('Перенесено на завтра');
      loadTodayFeed();
    };

    const openTodayEntry = async (entry) => {
      if (entry.kind === 'reminder') {
        switchTab('calendar');
        return;
      }
      if (entry.src.kind === 'global') {
        tab = 'global';
        settings.notesTab = 'global';
        saveSettings();
        loadedId = null;
        await renderPanel();
        if (notes.some((n) => n.id === entry.item.id)) {
          selectedId = entry.item.id;
          inspectorId = entry.item.id;
          inspectorListId = loadedId;
          renderList();
        }
      } else if (activeProject() && activeProject().id === entry.src.id) {
        tab = 'project';
        settings.notesTab = 'project';
        saveSettings();
        loadedId = null;
        await renderPanel();
        if (notes.some((n) => n.id === entry.item.id)) {
          selectedId = entry.item.id;
          inspectorId = entry.item.id;
          inspectorListId = loadedId;
          renderList();
        }
      } else {
        toast(t('Эта задача в проекте «{0}» — переключите активный проект слева', entry.src.name));
      }
    };

    const renderGroup = (title, dotCls, items) => {
      if (!items.length) return;
      const head = el('div', 'ag-grp ' + dotCls);
      head.append(el('span', 'ag-grp-dot ' + dotCls), el('span', 'ag-grp-lbl', title), el('span', 'ag-grp-cnt', String(items.length)));
      list.appendChild(head);

      for (const entry of items) {
        const isDone = entry.kind === 'task' ? entry.item.status === 'done' : !!entry.item.done;
        const row = el('div', 'nt-today-row' + (isDone ? ' done' : ''));
        const cb = el('button', 'nt-stbtn st-' + (isDone ? 'done' : (entry.item.status || 'todo')));
        cb.type = 'button';
        if (isDone) cb.appendChild(icon('check', 11));
        cb.addEventListener('click', (e) => { e.stopPropagation(); toggleTodayEntry(entry); });

        const info = el('div', 'nt-today-info');
        const tEl = el('div', 'nt-title', titleOf(entry.item.text) || t('(пусто)'));
        tEl.setAttribute('data-no-i18n', '');
        info.appendChild(tEl);

        const meta = el('div', 'nt-badges');
        const srcChip = el('span', 'nt-src-chip');
        srcChip.setAttribute('data-no-i18n', '');
        srcChip.append(icon(entry.kind === 'reminder' ? 'clock' : (entry.src.kind === 'global' ? 'globe' : 'folder'), 11), el('span', null, entry.src.name));
        meta.appendChild(srcChip);

        const dueIso = entry.kind === 'task' ? entry.item.dueAt : entry.item.at;
        if (dueIso) {
          const ds = dueState(dueIso, !!entry.item.allDay, isDone, now) || 'later';
          const db = el('span', 'nt-due ds-' + ds, formatDueShort(dueIso, !!entry.item.allDay, now, t));
          meta.appendChild(db);
        }
        info.appendChild(meta);

        const acts = el('div', 'nt-hacts');
        if (!isDone) {
          const snz = iconBtn('nt-act', 'arrow-right', 'Отложить на завтра', 13);
          snz.type = 'button';
          snz.addEventListener('click', (e) => { e.stopPropagation(); snoozeTodayEntry(entry); });
          acts.appendChild(snz);
        }
        const termProj = entry.src.proj || activeProject();
        if (termProj) {
          const snd = iconBtn('nt-act accent', 'terminal', 'В терминал', 13);
          snd.type = 'button';
          snd.addEventListener('click', (e) => {
            e.stopPropagation();
            const txt = entry.kind === 'task' ? formatNoteForTerminal(entry.item, t) : entry.item.text;
            sendNoteToTerminal(termProj, txt);
          });
          acts.appendChild(snd);
        }

        row.append(cb, info, acts);
        row.addEventListener('click', () => openTodayEntry(entry));
        list.appendChild(row);
      }
    };

    renderGroup('Просрочено', 'bk-overdue', overdue);
    renderGroup('Сегодня и в фокусе', 'bk-today', todayItems);
    renderGroup('Выполнено сегодня', 'bk-done', doneToday);

    wrap.appendChild(list);
  }

  // ---------------- операции списка ----------------
  function archiveDone() {
    const doneItems = notes.filter((x) => !x.archived && x.status === 'done');
    if (!doneItems.length) return;
    pushUndo(t('Выполненные задачи отправлены в архив'), notes);
    const ts = new Date().toISOString();
    for (const x of doneItems) {
      x.prevStatus = 'todo';
      x.archived = true;
      x.archivedAt = ts;
      if (!x.doneAt) x.doneAt = ts;
    }
    if (inspectorId && notes.find((n) => n.id === inspectorId && n.archived)) closeInspector();
    save();
    renderList();
    toast(t('В архив перенесено: {0}', doneItems.length), { actionLabel: 'Отменить', action: undoLast, ttl: 6000 });
  }

  async function copyText(note) {
    try { lite.copyText(note.text || ''); toast('Скопировано в буфер'); }
    catch (_) { toast('Не удалось скопировать', { kind: 'err' }); }
  }

  function setView(v) {
    if (v === view) return;
    if (v === 'kanban' && !kanbanWidened && window.innerWidth < 860) {
      try { lite.win.resizeBy(KANBAN_GROW); } catch (_) {}
      kanbanWidened = true;
    } else if (v === 'list' && kanbanWidened) {
      try { lite.win.resizeBy(-KANBAN_GROW); } catch (_) {}
      kanbanWidened = false;
    }
    view = v;
    settings.notesView = v;
    saveSettings();
    if (v === 'kanban' && filter === 'archived') filter = 'active';
    renderList();
  }

  function setSort(s) {
    if (s === sortMode) return;
    sortMode = s;
    settings.notesSort = s;
    saveSettings();
    renderList();
  }

  async function moveToOtherList(note, target) {
    if (!target) return;
    let destId, destName;
    if (target.kind === 'project') { destId = GLOBAL_ID; destName = 'Общие'; }
    else {
      const p = activeProject();
      if (!p) { toast('Нет активного проекта — некуда перенести'); return; }
      destId = p.id;
      destName = p.name;
    }
    let dest = await lite.store.notesGet(destId);
    if (readErr(dest)) {
      toast(t('Не прочитать список задач: {0} — он не изменится, пока файл не прочитается', readErr(dest)), { kind: 'err', ttl: 9000 });
      return;
    }
    if (!Array.isArray(dest)) dest = [];
    dest.unshift(normalizeNote(note));
    await lite.store.notesSet(destId, dest);
    broadcastChange(destId);
    const ix = notes.indexOf(note);
    if (ix >= 0) notes.splice(ix, 1);
    if (inspectorId === note.id) closeInspector();
    save();
    renderList();
    toast(t('Перенесено в «{0}»', t(destName)));
  }

  function sendToTerminal(note, target, alsoDelete) {
    const proj = termProject(target);
    if (!proj) { toast('Нет активного проекта — некуда отправить'); return; }
    if (!note.text) { toast('Задача пустая'); return; }
    const payload = formatNoteForTerminal(note, t);
    sendNoteToTerminal(proj, payload);
    if (alsoDelete) {
      deleteNoteInstant(note);
    } else if (autoDoing && !note.archived && note.status === 'todo') {
      note.status = 'doing';
      afterMutate(note);
    }
  }

  // ---------------- экспорт / импорт ----------------
  function exportMenu() {
    const curName = tab === 'global' ? t('общие') : (activeProject() ? activeProject().name : t('проект'));
    const { m, close } = makeModal(`
      <h2>Экспорт задач</h2>
      <div class="nt-exp">
        <button class="btn" data-scope="current">JSON — этот список (${escAttr(curName)})</button>
        <button class="btn" data-scope="all">JSON — все заметки (все проекты + общие)</button>
        <button class="btn" data-scope="md">Markdown — скопировать текущий список в буфер</button>
      </div>
      <div class="modal-actions"><button class="btn" data-cancel>Отмена</button></div>`);
    m.querySelector('[data-scope="current"]').onclick = () => { close(); doExport('current'); };
    m.querySelector('[data-scope="all"]').onclick = () => { close(); doExport('all'); };
    m.querySelector('[data-scope="md"]').onclick = () => {
      close();
      const target = currentTarget();
      if (!target) { toast('Откройте проект или вкладку «Общие»'); return; }
      const md = notesToMarkdown(target.name, notes, t);
      try { lite.copyText(md); toast('Markdown скопирован в буфер'); }
      catch (_) { toast('Не удалось скопировать', { kind: 'err' }); }
    };
    m.querySelector('[data-cancel]').onclick = () => close();
  }

  async function doExport(scope) {
    const out = { _format: 'lite-notes', version: 1, exportedAt: new Date().toISOString() };
    let nameBase;
    if (scope === 'all') {
      out.projects = {};
      for (const p of (getProjects ? getProjects() : [])) {
        const arr = await lite.store.notesGet(p.id);
        if (Array.isArray(arr) && arr.length) out.projects[p.id] = { name: p.name, path: p.path, notes: arr };
      }
      const g = await lite.store.notesGet(GLOBAL_ID);
      out.global = Array.isArray(g) ? g : [];
      nameBase = 'lite-notes-all';
    } else {
      const target = currentTarget();
      if (!target) { toast('Откройте проект или вкладку «Общие»'); return; }
      if (target.kind === 'global') { out.global = notes.slice(); nameBase = 'lite-notes-global'; }
      else { out.projects = { [target.id]: { name: target.name, path: target.proj.path, notes: notes.slice() } }; nameBase = 'lite-notes-' + target.name; }
    }
    const r = await lite.store.notesExport(JSON.stringify(out, null, 2), nameBase);
    if (!r || r.canceled) return;
    if (r.error) { toast(t('Ошибка экспорта: {0}', r.error), { kind: 'err' }); return; }
    toast('Экспортировано в файл');
  }

  async function mergeInto(id, incoming) {
    if (!Array.isArray(incoming)) return 0;
    let cur = await lite.store.notesGet(id);
    if (readErr(cur)) throw new Error(readErr(cur));
    if (!Array.isArray(cur)) cur = [];
    const seen = new Set(cur.map((n) => n && n.id));
    let added = 0;
    for (const n of incoming) {
      if (!n || typeof n.text !== 'string') continue;
      const nid = (n.id && !seen.has(n.id)) ? n.id : genId('n');
      if (seen.has(nid)) continue;
      seen.add(nid);
      cur.push(normalizeNote({ ...n, id: nid }));
      added++;
    }
    if (added) { await lite.store.notesSet(id, cur); broadcastChange(id); }
    return added;
  }

  async function replaceInto(id, incoming) {
    const arr = (Array.isArray(incoming) ? incoming : [])
      .filter((n) => n && typeof n.text === 'string')
      .map(normalizeNote);
    await lite.store.notesSet(id, arr);
    broadcastChange(id);
    return arr.length;
  }

  async function importNotes() {
    const r = await lite.store.notesImport();
    if (!r || r.canceled) return;
    if (r.error) { toast(t('Ошибка импорта: {0}', r.error), { kind: 'err' }); return; }
    let data;
    try { data = JSON.parse(r.content); }
    catch { toast('Файл не является JSON', { kind: 'err' }); return; }
    if (!data || data._format !== 'lite-notes') { toast('Это не файл заметок LiteEditor', { kind: 'err' }); return; }
    chooseImportMode(data);
  }

  function chooseImportMode(data) {
    const hasGlobal = Array.isArray(data.global);
    const projCount = (data.projects && typeof data.projects === 'object') ? Object.keys(data.projects).length : 0;
    const scope = [hasGlobal ? t('общие') : null, projCount ? t('проектов: {0}', projCount) : null].filter(Boolean).join(' · ') || t('нет данных');
    const { m, close } = makeModal(`
      <h2>Импорт заметок</h2>
      <div class="nt-modal-hint">${escAttr(t('В файле: {0}.', scope))}</div>
      <div class="nt-imp-warn">⚠ <b>Заменить</b> (по умолчанию) — затрёт эти списки данными из файла, текущие задачи в них пропадут.<br><b>Добавить</b> — допишет недостающие, ничего не теряя.</div>
      <div class="nt-exp">
        <button class="btn primary" data-mode="replace">Заменить (по умолчанию)</button>
        <button class="btn" data-mode="merge">Добавить к существующим</button>
      </div>
      <div class="modal-actions"><button class="btn" data-cancel>Отмена</button></div>`);
    m.querySelector('[data-mode="replace"]').onclick = () => { close(); applyImport(data, 'replace'); };
    m.querySelector('[data-mode="merge"]').onclick = () => { close(); applyImport(data, 'merge'); };
    m.querySelector('[data-cancel]').onclick = () => close();
    setTimeout(() => m.querySelector('[data-mode="replace"]').focus(), 0);
  }

  async function applyImport(data, mode) {
    let lists = 0, total = 0;
    const handle = async (id, arr) => {
      if (!Array.isArray(arr)) return;
      try { total += await (mode === 'replace' ? replaceInto(id, arr) : mergeInto(id, arr)); lists++; }
      catch (e) { toast(t('Список {0} не тронут: {1}', id, (e && e.message) || e), { kind: 'err', ttl: 9000 }); }
    };
    if (Array.isArray(data.global)) await handle(GLOBAL_ID, data.global);
    if (data.projects && typeof data.projects === 'object') {
      for (const [pid, entry] of Object.entries(data.projects)) {
        await handle(pid, entry && Array.isArray(entry.notes) ? entry.notes : (Array.isArray(entry) ? entry : null));
      }
    }
    loadedId = null;
    await renderPanel();
    if (mode === 'replace') toast(t('Заменено списков: {0} ({1} задач)', lists, total));
    else toast(total ? t('Добавлено задач: {0} в {1} списк(а/ов)', total, lists) : t('Новых задач не найдено — всё уже есть'));
  }

  // ---------------- модалка шорткатов ----------------
  function openShortcutsModal() {
    const rows = [
      ['N / C', 'Новая задача (фокус в быстрый ввод)'],
      ['/', 'Поиск по задачам'],
      ['J / K / ↑ / ↓', 'Навигация по списку'],
      ['Enter', 'Открыть или закрыть детали (Inspector)'],
      ['Space', 'Сменить статус выбранной задачи'],
      ['1 / 2 / 3', 'Приоритет: Обычная / Важная / Срочная'],
      ['T', 'В фокус «Сегодня»'],
      ['X', 'Мультивыбор (или Shift+клик)'],
      ['Ctrl+Enter', 'Отправить выбранную задачу в терминал'],
      ['B', 'Переключить Список ↔ Канбан'],
      ['Ctrl+Z', 'Отменить удаление / архивацию'],
      ['Del', 'Удалить выбранную задачу'],
      ['Esc', 'Закрыть детали / снять выделение'],
    ];
    const { m, close } = makeModal(`
      <h2>Горячие клавиши задачника</h2>
      <div class="nt-kbd-list"></div>
      <div class="modal-actions"><button class="btn primary" data-ok>Закрыть</button></div>`);
    m.classList.add('nt-modal');
    const box = m.querySelector('.nt-kbd-list');
    for (const [key, desc] of rows) {
      const r = el('div', 'nt-kbd-row');
      r.append(el('kbd', null, key), el('span', null, desc));
      box.appendChild(r);
    }
    m.querySelector('[data-ok]').onclick = close;
  }

  // ---------------- клавиатурная навигация ----------------
  let keysWired = false;
  function wireKeyboard() {
    if (keysWired) return;
    keysWired = true;
    document.addEventListener('keydown', (e) => {
      if (!notesOpen) return;
      const modalOpen = Boolean($('.modal-overlay'));
      if (modalOpen) return;

      const menuOpen = Boolean($('#menu-layer') && $('#menu-layer').firstChild);
      if (e.key === 'Escape') {
        if (menuOpen) return;
        if (multiSel.size) { multiSel.clear(); renderList(); return; }
        if (inspectorId) { closeInspector(); return; }
        return;
      }

      const activeTag = document.activeElement && document.activeElement.tagName;
      const inEditable = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT'
        || (document.activeElement && document.activeElement.isContentEditable);

      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !inEditable) {
        e.preventDefault();
        undoLast();
        return;
      }

      if (inEditable) return;
      if (tab !== 'project' && tab !== 'global') return;

      if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) {
        e.preventDefault();
        openShortcutsModal();
        return;
      }
      if (e.code === 'Slash' && !e.shiftKey) {
        e.preventDefault();
        const s = $('[data-search]');
        if (s) s.focus();
        return;
      }
      if (e.code === 'KeyN' || e.code === 'KeyC') {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        const q = $('[data-quick]');
        if (q) q.focus();
        return;
      }
      if (e.code === 'KeyB' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setView(view === 'kanban' ? 'list' : 'kanban');
        return;
      }

      const vis = view === 'kanban' && filter !== 'archived'
        ? sortArray(notes.filter((n) => !n.archived && matchesQuery(n)))
        : visible();
      if (!vis.length) return;

      const curIdx = selectedId ? vis.findIndex((n) => n.id === selectedId) : -1;

      if (e.code === 'KeyJ' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = vis[Math.min(vis.length - 1, curIdx + 1)];
        if (next) selectCard(next.id);
        return;
      }
      if (e.code === 'KeyK' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = vis[curIdx <= 0 ? 0 : curIdx - 1];
        if (prev) selectCard(prev.id);
        return;
      }

      const curNote = curIdx >= 0 ? vis[curIdx] : null;
      if (!curNote) return;

      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendToTerminal(curNote, currentTarget(), false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (inspectorId === curNote.id) closeInspector();
        else openInspector(curNote.id);
      } else if (e.code === 'Space') {
        e.preventDefault();
        if (curNote.archived) { archiveNote(curNote); return; }
        const cycle = activeStatuses();
        setStatus(curNote, cycle[(cycle.indexOf(curNote.status) + 1) % cycle.length]);
        afterMutate(curNote);
      } else if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3') {
        e.preventDefault();
        curNote.prio = e.code === 'Digit1' ? 0 : e.code === 'Digit2' ? 1 : 2;
        afterMutate(curNote);
      } else if (e.code === 'KeyT') {
        e.preventDefault();
        curNote.today = !curNote.today;
        afterMutate(curNote);
      } else if (e.code === 'KeyX') {
        e.preventDefault();
        if (multiSel.has(curNote.id)) multiSel.delete(curNote.id);
        else multiSel.add(curNote.id);
        const card = cardEls.get(curNote.id);
        if (card) card.classList.toggle('multi', multiSel.has(curNote.id));
        renderBulkBar();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteNoteInstant(curNote);
      }
    });
  }

  // ---------------- вкладки и панель ----------------
  function switchTab(name) {
    if (name === tab) return;
    tab = name;
    settings.notesTab = name;
    saveSettings();
    loadedId = null;
    closeInspector();
    multiSel.clear();
    renderPanel();
  }

  async function renderPanel() {
    if (!notesOpen) return;
    wireKeyboard();
    if (tab === 'calendar') {
      renderList();
      return;
    }
    if (tab === 'today') {
      renderList();
      loadTodayFeed();
      return;
    }
    const target = currentTarget();
    if (target && target.id !== loadedId) {
      closeInspector();
      multiSel.clear();
      const ok = await load(target.id);
      if (!ok || !notesOpen) return;
    } else if (!target) {
      closeInspector();
      multiSel.clear();
      notes = [];
      loadedId = null;
    }
    renderList();
  }

  function setNotesOpen(open, opts = {}) {
    if (open && tab === 'project' && !activeProject() && !opts.allowEmpty) {
      toast('Сначала открой проект');
      return;
    }
    if (open === notesOpen) {
      if (open) renderPanel();
      return;
    }
    if (open) closeOtherPanels('notes');
    const delta = layout.notes + GUTTER;
    notesOpen = open;
    $('#notes-pane').classList.toggle('hidden', !open);
    $('#gutter-notes').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta);
    saveUiState();
    if (open) renderPanel();
    else { loadedId = null; closeInspector(); }
    setTimeout(refitActiveTerminal, 150);
  }

  function toggleNotes() {
    setNotesOpen(!notesOpen);
  }

  return {
    isOpen: () => notesOpen,
    setOpen: setNotesOpen,
    toggle: toggleNotes,
    exportMenu,
    importNotes,
    renderPanel: () => renderPanel(),
    onExternalChange: (id) => {
      if (!notesOpen) return;
      if (tab === 'today') { loadTodayFeed(); return; }
      if (tab === 'calendar') { agenda.refreshDue(); return; }
      if (id === loadedId) { loadedId = null; renderPanel(); }
    },
    onAgendaExternalChange: () => {
      if (!notesOpen) return;
      if (tab === 'today') { loadTodayFeed(); return; }
      if (tab === 'calendar') agenda.reload();
    },
    focusCalendar: () => {
      if (tab !== 'calendar') { tab = 'calendar'; settings.notesTab = 'calendar'; saveSettings(); }
      if (!notesOpen) setNotesOpen(true, { allowEmpty: true });
      else renderPanel();
    },
  };
}
