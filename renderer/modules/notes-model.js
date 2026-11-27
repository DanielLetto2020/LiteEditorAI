// Чистая модель данных и утилиты для модуля «Задачи» и «Календаря».
// Без зависимостей от DOM и Electron — легко тестируется в Node.

export const GLOBAL_ID = '__global__';
export const STATUSES = ['todo', 'doing', 'review', 'done'];
export const STATUS_LABEL = {
  todo: 'К выполнению',
  doing: 'В работе',
  review: 'На проверке',
  done: 'Готово',
};
export const PRIO_LABEL = ['Обычная', 'Важная', 'Срочная'];
export const REPEAT_ORDER = ['', 'daily', 'weekdays', 'weekly', 'monthly'];
export const REPEAT_LABEL = {
  '': 'Не повторять',
  daily: 'Каждый день',
  weekdays: 'По будням',
  weekly: 'Раз в неделю',
  monthly: 'Раз в месяц',
};

export const BUILTIN_TEMPLATES = [
  {
    id: 'bug',
    name: 'Баг-репорт',
    text: 'Исправить баг: \n\nШаги воспроизведения:\n1. \n\nОжидаемо:\n\nФактически:',
    prio: 1,
    tags: ['bug'],
    subtasks: ['Воспроизвести проблему', 'Найти причину и исправить', 'Проверить регрессию'],
  },
  {
    id: 'feat',
    name: 'Новая фича',
    text: 'Реализовать: \n\nЦель:\n\nДетали реализации:',
    prio: 0,
    tags: ['feat'],
    subtasks: ['Продумать структуру', 'Реализовать логику', 'Добавить тесты и проверить'],
  },
  {
    id: 'refactor',
    name: 'Ревью / рефакторинг',
    text: 'Отрефакторить: \n\nЧто улучшить:\n\nОграничения и риски:',
    prio: 0,
    tags: ['refactor'],
    subtasks: ['Изучить текущий код', 'Выполнить рефакторинг', 'Прогнать lint и тесты'],
  },
];

const defaultTr = (s, ...args) => (
  args.length ? String(s).replace(/\{(\d)\}/g, (_, i) => (args[Number(i)] ?? '')) : String(s)
);

export function genId(prefix = 'n') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function titleOf(text) {
  const s = String(text || '').trim();
  const i = s.indexOf('\n');
  return (i < 0 ? s : s.slice(0, i)).trim();
}

export function bodyOf(text) {
  const s = String(text || '');
  const i = s.indexOf('\n');
  return i < 0 ? '' : s.slice(i + 1).trim();
}

export function joinTitleBody(title, body) {
  const t0 = String(title || '').replace(/\r?\n/g, ' ').trim();
  const b0 = String(body || '').trim();
  if (!b0) return t0;
  if (!t0) return b0;
  return t0 + '\n' + b0;
}

export function cleanTag(raw) {
  const s = String(raw || '').trim().replace(/^#+/, '').toLowerCase();
  const cleaned = s.replace(/[^\p{L}\p{N}_-]+/gu, '').slice(0, 24);
  return cleaned;
}

export function tagColorIndex(tag) {
  const s = cleanTag(tag) || String(tag || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (Math.abs(h) % 8) + 1;
}

function validIso(v) {
  if (!v || typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Нормализует задачу (безопасная миграция старых записей без потери полей).
 * Инвариант: архивная задача всегда имеет status === 'done', чтобы countActiveNotes
 * в ядре не включал архив в счётчик открытых задач.
 */
export function normalizeNote(raw) {
  const n = (raw && typeof raw === 'object') ? raw : {};
  const archived = !!n.archived;
  const rawStatus = STATUSES.includes(n.status) ? n.status : 'todo';
  const prevStatus = STATUSES.includes(n.prevStatus) && n.prevStatus !== 'done'
    ? n.prevStatus
    : (rawStatus !== 'done' ? rawStatus : 'todo');
  const status = archived ? 'done' : rawStatus;

  const prioNum = Number(n.prio);
  const prio = (prioNum === 1 || prioNum === 2) ? prioNum : 0;

  const subs = [];
  if (Array.isArray(n.subtasks)) {
    for (const s of n.subtasks) {
      if (!s || typeof s !== 'object') continue;
      const st = typeof s.text === 'string' ? s.text : '';
      subs.push({
        id: s.id ? String(s.id) : genId('s'),
        text: st,
        done: !!s.done,
      });
    }
  }

  const tagSet = new Set();
  if (Array.isArray(n.tags)) {
    for (const tg of n.tags) {
      const c = cleanTag(tg);
      if (c) tagSet.add(c);
    }
  }

  const dueAt = validIso(n.dueAt);
  const allDay = dueAt ? !!n.allDay : false;
  const pomoRaw = Number(n.pomoCount);
  const pomoCount = Number.isFinite(pomoRaw) && pomoRaw > 0 ? Math.floor(pomoRaw) : 0;

  return {
    id: n.id ? String(n.id) : genId('n'),
    text: typeof n.text === 'string' ? n.text : '',
    status,
    prio,
    subtasks: subs,
    tags: [...tagSet],
    dueAt,
    allDay,
    today: !!n.today,
    archived,
    prevStatus: archived ? prevStatus : null,
    archivedAt: archived ? (validIso(n.archivedAt) || new Date().toISOString()) : null,
    createdAt: validIso(n.createdAt) || new Date().toISOString(),
    doneAt: status === 'done' ? (validIso(n.doneAt) || null) : null,
    pomoCount,
  };
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function dayKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}

export function toLocalDateInput(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}

export function toLocalDateTimeInput(d) {
  const x = new Date(d);
  return `${toLocalDateInput(x)}T${pad2(x.getHours())}:${pad2(x.getMinutes())}`;
}

export function isSameLocalDay(isoA, dateB) {
  if (!isoA || !dateB) return false;
  const a = new Date(isoA);
  const b = new Date(dateB);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
  return dayKey(a) === dayKey(b);
}

/**
 * Определяет состояние срока задачи относительно now.
 * @returns {'overdue'|'today'|'tomorrow'|'soon'|'later'|null}
 */
export function dueState(dueAt, allDay, done, now = new Date()) {
  if (!dueAt) return null;
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return null;
  if (done) return 'later';
  const dayDiff = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86400000);
  if (allDay) {
    if (dayDiff < 0) return 'overdue';
  } else if (d.getTime() < now.getTime()) {
    return 'overdue';
  }
  if (dayDiff <= 0) return 'today';
  if (dayDiff === 1) return 'tomorrow';
  if (dayDiff <= 7) return 'soon';
  return 'later';
}

export function formatDueShort(dueAt, allDay, now = new Date(), tr = defaultTr) {
  if (!dueAt) return '';
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return '';
  const dayDiff = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86400000);
  const timeStr = allDay ? '' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (dayDiff === 0) return timeStr ? tr('Сегодня, {0}', timeStr) : tr('Сегодня');
  if (dayDiff === 1) return timeStr ? tr('Завтра, {0}', timeStr) : tr('Завтра');
  if (dayDiff === -1) return timeStr ? tr('Вчера, {0}', timeStr) : tr('Вчера');
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const base = `${d.getDate()} ${tr(months[d.getMonth()])}`;
  const withYear = d.getFullYear() !== now.getFullYear() ? `${base} ${d.getFullYear()}` : base;
  return timeStr ? `${withYear}, ${timeStr}` : withYear;
}

function makeLocalDate(year, month1, day, hh, mm) {
  const d = new Date(year, month1 - 1, day, hh ?? 0, mm ?? 0, 0, 0);
  if (d.getFullYear() !== year || d.getMonth() !== month1 - 1 || d.getDate() !== day) return null;
  return d;
}

function validTime(hhStr, mmStr) {
  if (hhStr == null || mmStr == null) return null;
  const hh = Number(hhStr);
  const mm = Number(mmStr);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

/**
 * Парсит строку быстрого ввода с inline-токенами:
 *   !1 / !2 / !важно / !срочно  → приоритет
 *   #тег                        → теги
 *   * / @фокус / @focus         → в фокус «Сегодня»
 *   @сегодня [HH:MM], @завтра [HH:MM], @послезавтра [HH:MM], @неделя [HH:MM],
 *   @+Nд [HH:MM], @+Nч, @YYYY-MM-DD [HH:MM], @DD.MM[.YYYY] [HH:MM], @HH:MM
 */
export function parseQuickInput(raw, now = new Date(), tr = defaultTr) {
  const input = String(raw || '');
  const lines = input.split('\n');
  let first = lines[0] || '';

  let prio = 0;
  let explicitPrio = false;
  let today = false;
  let dueAt = null;
  let allDay = false;
  const tagSet = new Set();

  const applyTime = (baseDate, hhStr, mmStr) => {
    const tm = validTime(hhStr, mmStr);
    const d = new Date(baseDate);
    if (tm) {
      d.setHours(tm.hh, tm.mm, 0, 0);
      allDay = false;
    } else {
      d.setHours(0, 0, 0, 0);
      allDay = true;
    }
    dueAt = d.toISOString();
  };

  // Сначала вытаскиваем составные @-даты с опциональным временем
  const reRelDay = /(^|\s)@(сегодня|today|завтра|tomorrow|послезавтра|неделя|week)(?:\s+(\d{1,2}):(\d{2}))?(?=\s|$)/giu;
  first = first.replace(reRelDay, (_m, lead, word, hh, mm) => {
    const w = word.toLowerCase();
    const d = startOfDay(now);
    const add = (/^завтра|tomorrow$/i).test(w) ? 1
      : (/^послезавтра$/i).test(w) ? 2
        : (/^неделя|week$/i).test(w) ? 7 : 0;
    d.setDate(d.getDate() + add);
    applyTime(d, hh, mm);
    if (add === 0) today = true;
    return lead;
  });

  const reOffset = /(^|\s)@\+(\d{1,3})(д|d|ч|h)(?:\s+(\d{1,2}):(\d{2}))?(?=\s|$)/giu;
  first = first.replace(reOffset, (_m, lead, numStr, unit, hh, mm) => {
    const cnt = Number(numStr);
    const u = unit.toLowerCase();
    if (u === 'ч' || u === 'h') {
      const d = new Date(now.getTime() + cnt * 3600000);
      allDay = false;
      dueAt = d.toISOString();
    } else {
      const d = startOfDay(now);
      d.setDate(d.getDate() + cnt);
      applyTime(d, hh, mm);
    }
    return lead;
  });

  const reIso = /(^|\s)@(\d{4})-(\d{2})-(\d{2})(?:[T\s]+(\d{1,2}):(\d{2}))?(?=\s|$)/g;
  first = first.replace(reIso, (full, lead, yy, mm, dd, hh, min) => {
    const d = makeLocalDate(Number(yy), Number(mm), Number(dd), 0, 0);
    if (!d) return full;
    applyTime(d, hh, min);
    return lead;
  });

  const reDot = /(^|\s)@(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?:\s+(\d{1,2}):(\d{2}))?(?=\s|$)/g;
  first = first.replace(reDot, (full, lead, dd, mm, yy, hh, min) => {
    let year = now.getFullYear();
    if (yy) year = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
    let d = makeLocalDate(year, Number(mm), Number(dd), 0, 0);
    if (!d) return full;
    if (!yy && startOfDay(d).getTime() < startOfDay(now).getTime()) {
      const nextY = makeLocalDate(year + 1, Number(mm), Number(dd), 0, 0);
      if (nextY) d = nextY;
    }
    applyTime(d, hh, min);
    return lead;
  });

  const reTimeOnly = /(^|\s)@(\d{1,2}):(\d{2})(?=\s|$)/g;
  first = first.replace(reTimeOnly, (full, lead, hh, min) => {
    const tm = validTime(hh, min);
    if (!tm) return full;
    const d = new Date(now);
    d.setHours(tm.hh, tm.mm, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    allDay = false;
    dueAt = d.toISOString();
    return lead;
  });

  // Фокус дня: * или @фокус / @focus
  const reFocus = /(^|\s)(?:\*|@(?:фокус|focus))(?=\s|$)/giu;
  first = first.replace(reFocus, (_m, lead) => {
    today = true;
    return lead;
  });

  // Приоритеты: !2 / !! / !срочно / !urgent / !1 / ! / !важно / !high / !0
  const rePrio = /(^|\s)!(2|!|срочно|urgent|1|важно|high|0)?(?=\s|$)/giu;
  first = first.replace(rePrio, (_m, lead, code) => {
    const c = (code || '').toLowerCase();
    explicitPrio = true;
    if (c === '2' || c === '!' || c === 'срочно' || c === 'urgent') prio = 2;
    else if (c === '0') prio = 0;
    else prio = 1;
    return lead;
  });

  // Теги: #tag
  const reTag = /(^|\s)#([\p{L}\p{N}_-]{1,24})(?=\s|$|[.,;!?])/gu;
  first = first.replace(reTag, (full, lead, rawTag) => {
    const tg = cleanTag(rawTag);
    if (!tg) return full;
    tagSet.add(tg);
    return lead;
  });

  const cleanFirst = first.replace(/\s{2,}/g, ' ').trim();
  const rest = lines.slice(1).join('\n').trim();
  const finalFirst = cleanFirst || (lines[0] || '').trim();
  const text = rest ? (finalFirst ? finalFirst + '\n' + rest : rest) : finalFirst;

  const tokens = [];
  if (explicitPrio && prio > 0) tokens.push({ kind: 'prio', prio, label: tr(PRIO_LABEL[prio]) });
  if (today && (!dueAt || !isSameLocalDay(dueAt, now))) tokens.push({ kind: 'today', label: tr('Фокус сегодня') });
  if (dueAt) tokens.push({ kind: 'due', label: formatDueShort(dueAt, allDay, now, tr) });
  for (const tg of tagSet) tokens.push({ kind: 'tag', tag: tg, label: '#' + tg });

  return {
    text,
    prio,
    tags: [...tagSet],
    dueAt,
    allDay,
    today,
    tokens,
  };
}

/**
 * Вычисляет следующую дату повторяющегося напоминания (после исходной и после now).
 */
export function computeNextRepeat(atIso, repeat, _allDay = false, now = new Date()) {
  if (!atIso || !REPEAT_ORDER.includes(repeat) || !repeat) return null;
  const orig = new Date(atIso);
  if (Number.isNaN(orig.getTime())) return null;

  const anchorDay = orig.getDate();
  const d = new Date(orig.getTime());
  const stepOnce = () => {
    if (repeat === 'daily') {
      d.setDate(d.getDate() + 1);
    } else if (repeat === 'weekdays') {
      do {
        d.setDate(d.getDate() + 1);
      } while (d.getDay() === 0 || d.getDay() === 6);
    } else if (repeat === 'weekly') {
      d.setDate(d.getDate() + 7);
    } else if (repeat === 'monthly') {
      const hh = d.getHours(), mm = d.getMinutes(), ss = d.getSeconds(), ms = d.getMilliseconds();
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(anchorDay, lastDay));
      d.setHours(hh, mm, ss, ms);
    }
  };

  let guard = 0;
  while ((d.getTime() <= orig.getTime() || d.getTime() <= now.getTime()) && guard < 1000) {
    stepOnce();
    guard++;
  }
  return d.toISOString();
}

/**
 * Считает новый срок при откладывании (Snooze).
 * @param {'15m'|'1h'|'3h'|'tomorrow'|'week'} kind
 */
export function computeSnooze(kind, now = new Date()) {
  if (kind === '15m') return { at: new Date(now.getTime() + 15 * 60000).toISOString(), allDay: false };
  if (kind === '1h') return { at: new Date(now.getTime() + 3600000).toISOString(), allDay: false };
  if (kind === '3h') return { at: new Date(now.getTime() + 3 * 3600000).toISOString(), allDay: false };
  if (kind === 'tomorrow') {
    const d = startOfDay(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return { at: d.toISOString(), allDay: false };
  }
  if (kind === 'week') {
    const d = startOfDay(now);
    d.setDate(d.getDate() + 7);
    d.setHours(9, 0, 0, 0);
    return { at: d.toISOString(), allDay: false };
  }
  return null;
}

/**
 * Экспорт списка задач в чистый Markdown с чекбоксами и подзадачами.
 */
export function notesToMarkdown(title, notesArr, tr = defaultTr) {
  const active = (Array.isArray(notesArr) ? notesArr : []).map(normalizeNote).filter((n) => !n.archived);
  const lines = [`# ${title || tr('Задачи')}`, ''];
  if (!active.length) {
    lines.push(`_${tr('Список пуст.')}_`);
    return lines.join('\n');
  }
  for (const st of STATUSES) {
    const grp = active.filter((n) => n.status === st);
    if (!grp.length) continue;
    lines.push(`## ${tr(STATUS_LABEL[st])}`);
    lines.push('');
    for (const n of grp) {
      const box = n.status === 'done' ? '[x]' : '[ ]';
      const meta = [];
      if (n.prio > 0) meta.push(`!${n.prio}`);
      if (n.today) meta.push('★');
      if (n.dueAt) {
        const dd = new Date(n.dueAt);
        meta.push(`@${toLocalDateInput(dd)}${n.allDay ? '' : ' ' + pad2(dd.getHours()) + ':' + pad2(dd.getMinutes())}`);
      }
      for (const tg of n.tags) meta.push('#' + tg);
      const suffix = meta.length ? ` (${meta.join(' ')})` : '';
      lines.push(`- ${box} **${titleOf(n.text) || tr('(без названия)')}**${suffix}`);
      const body = bodyOf(n.text);
      if (body) {
        for (const bl of body.split('\n')) lines.push('  ' + bl);
      }
      for (const sub of n.subtasks) {
        if (!sub.text) continue;
        lines.push(`  - [${sub.done ? 'x' : ' '}] ${sub.text}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Форматирует задачу перед вставкой в терминал (подхватывает невыполненные подзадачи).
 */
export function formatNoteForTerminal(note, tr = defaultTr) {
  const n = normalizeNote(note);
  const base = (n.text || '').trim();
  const openSubs = n.subtasks.filter((s) => !s.done && (s.text || '').trim());
  if (!openSubs.length) return base;
  const subBlock = openSubs.map((s) => `- [ ] ${s.text.trim()}`).join('\n');
  return `${base}\n\n${tr('Подзадачи:')}\n${subBlock}`;
}
