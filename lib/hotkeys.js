// Реестр, нормализация, сопоставление и проверка конфликтов горячих клавиш LiteEditor.
// Используется в renderer/renderer.js, renderer/term-core.js, renderer/proj-term-window.js,
// renderer/modules/files.js и покрывается тестами test/hotkeys.test.js.

'use strict';

/** @typedef {'app' | 'files'} HotkeyScope */
/** @typedef {{ id: string, label: string, scope: HotkeyScope }} HotkeyGroup */
/** @typedef {{ id: string, group: string, scope: HotkeyScope, label: string, desc: string, defaultCombo: string }} HotkeyDef */

/** @type {HotkeyGroup[]} */
const HOTKEY_GROUPS = [
  { id: 'window', label: 'Окно и навигация', scope: 'app' },
  { id: 'terminal', label: 'Терминал и вкладки', scope: 'app' },
  { id: 'files', label: 'Редактор кода («Проект»)', scope: 'files' },
];

/** @type {HotkeyDef[]} */
const HOTKEY_DEFS = [
  // ---- Окно и навигация ----
  { id: 'toggleSingle', group: 'window', scope: 'app', label: 'Один терминал', desc: 'Свернуть или развернуть список проектов', defaultCombo: 'Ctrl+Backslash' },
  { id: 'palette', group: 'window', scope: 'app', label: 'Палитра команд', desc: 'Быстрый запуск команд и переход к проектам', defaultCombo: 'Ctrl+KeyK' },
  { id: 'globalSearch', group: 'window', scope: 'app', label: 'Найти во всех проектах', desc: 'Поиск по файлам и буферам терминалов', defaultCombo: 'Ctrl+Shift+KeyF' },
  { id: 'openFiles', group: 'window', scope: 'app', label: 'Панель «Проект»', desc: 'Открыть или скрыть дерево файлов, редактор кода и Git', defaultCombo: 'Ctrl+Shift+KeyE' },
  { id: 'toggleMcp', group: 'window', scope: 'app', label: 'Панель «MCP-инструменты»', desc: 'Показать или скрыть правую колонку MCP-вызовов и доступов', defaultCombo: 'Ctrl+Shift+KeyM' },
  { id: 'openSettings', group: 'window', scope: 'app', label: 'Открыть настройки', desc: 'Окно параметров редактора', defaultCombo: 'Ctrl+Comma' },
  { id: 'nextProject', group: 'window', scope: 'app', label: 'Следующий проект', desc: 'Переключиться на следующую видимую карточку', defaultCombo: 'Ctrl+Tab' },
  { id: 'prevProject', group: 'window', scope: 'app', label: 'Предыдущий проект', desc: 'Переключиться на предыдущую видимую карточку', defaultCombo: 'Ctrl+Shift+Tab' },

  // ---- Терминал и вкладки ----
  { id: 'newTab', group: 'terminal', scope: 'app', label: 'Новая вкладка терминала', desc: 'Открыть дополнительную сессию в активном проекте', defaultCombo: 'Ctrl+Shift+KeyT' },
  { id: 'closeTab', group: 'terminal', scope: 'app', label: 'Закрыть вкладку терминала', desc: 'Закрыть активную вкладку (с защитой живых процессов)', defaultCombo: 'Ctrl+Shift+KeyW' },
  { id: 'nextTab', group: 'terminal', scope: 'app', label: 'Следующая вкладка терминала', desc: 'Перейти к следующей вкладке проекта', defaultCombo: 'Ctrl+PageDown' },
  { id: 'prevTab', group: 'terminal', scope: 'app', label: 'Предыдущая вкладка терминала', desc: 'Перейти к предыдущей вкладке проекта', defaultCombo: 'Ctrl+PageUp' },
  { id: 'termSearch', group: 'terminal', scope: 'app', label: 'Поиск в терминале', desc: 'Найти текст в буфере активного терминала', defaultCombo: 'Ctrl+KeyF' },
  { id: 'termSplit', group: 'terminal', scope: 'app', label: 'Разделить терминал', desc: 'Включить или выключить вертикальный сплит', defaultCombo: 'Ctrl+Shift+KeyD' },
  { id: 'termNewline', group: 'terminal', scope: 'app', label: 'Перенос строки без отправки', desc: 'Вставить перенос строки в многострочном промпте', defaultCombo: 'Ctrl+Enter' },
  { id: 'fontUp', group: 'terminal', scope: 'app', label: 'Увеличить шрифт терминала', desc: 'Также работает клавиша «+» на NumPad', defaultCombo: 'Ctrl+Equal' },
  { id: 'fontDown', group: 'terminal', scope: 'app', label: 'Уменьшить шрифт терминала', desc: 'Также работает клавиша «−» на NumPad', defaultCombo: 'Ctrl+Minus' },

  // ---- Редактор кода («Проект») ----
  { id: 'files.quickOpen', group: 'files', scope: 'files', label: 'Быстрое открытие файла', desc: 'Поиск файла проекта по имени', defaultCombo: 'Ctrl+KeyP' },
  { id: 'files.commandPalette', group: 'files', scope: 'files', label: 'Палитра команд редактора', desc: 'Все команды окна «Проект»', defaultCombo: 'Ctrl+Shift+KeyP' },
  { id: 'files.save', group: 'files', scope: 'files', label: 'Сохранить файл', desc: 'Сохранить активный буфер на диск', defaultCombo: 'Ctrl+KeyS' },
  { id: 'files.gotoLine', group: 'files', scope: 'files', label: 'Перейти к строке', desc: 'Переход по номеру строки и столбца', defaultCombo: 'Ctrl+KeyG' },
  { id: 'files.fileSymbols', group: 'files', scope: 'files', label: 'Символы файла', desc: 'Оглавление функций и классов текущего файла', defaultCombo: 'Ctrl+Shift+KeyO' },
  { id: 'files.projectSymbols', group: 'files', scope: 'files', label: 'Символы проекта', desc: 'Поиск определений по всему проекту', defaultCombo: 'Ctrl+KeyT' },
  { id: 'files.projectSearch', group: 'files', scope: 'files', label: 'Поиск по проекту', desc: 'Открыть боковую панель поиска по файлам', defaultCombo: 'Ctrl+Shift+KeyF' },
  { id: 'files.projectReplace', group: 'files', scope: 'files', label: 'Замена по проекту', desc: 'Открыть поиск и замену по файлам', defaultCombo: 'Ctrl+Shift+KeyR' },
  { id: 'files.splitRight', group: 'files', scope: 'files', label: 'Разделить редактор вправо', desc: 'Открыть вторую колонку редактора кода', defaultCombo: 'Ctrl+Backslash' },
  { id: 'files.wordWrap', group: 'files', scope: 'files', label: 'Перенос длинных строк', desc: 'Переключить перенос строк в редакторе кода', defaultCombo: 'Alt+KeyZ' },
  { id: 'files.closeTab', group: 'files', scope: 'files', label: 'Закрыть вкладку файла', desc: 'Закрыть текущий файл (в раскладке JetBrains Ctrl+W остаётся за выделением)', defaultCombo: 'Ctrl+KeyW' },
  { id: 'files.toggleBookmark', group: 'files', scope: 'files', label: 'Поставить или снять закладку', desc: 'Закладка на текущей строке кода', defaultCombo: 'Ctrl+F2' },
  { id: 'files.zoomIn', group: 'files', scope: 'files', label: 'Увеличить шрифт кода', desc: 'Масштаб редактора кода', defaultCombo: 'Ctrl+Equal' },
  { id: 'files.zoomOut', group: 'files', scope: 'files', label: 'Уменьшить шрифт кода', desc: 'Масштаб редактора кода', defaultCombo: 'Ctrl+Minus' },
  { id: 'files.zoomReset', group: 'files', scope: 'files', label: 'Сбросить размер шрифта кода', desc: 'Вернуть стандартный масштаб редактора кода', defaultCombo: 'Ctrl+Digit0' },
];

/** @type {Map<string, HotkeyDef>} */
const HOTKEY_BY_ID = new Map(HOTKEY_DEFS.map((d) => [d.id, d]));

const MOD_ALIASES = new Map([
  ['ctrl', 'Ctrl'], ['control', 'Ctrl'],
  ['alt', 'Alt'], ['option', 'Alt'],
  ['shift', 'Shift'],
  ['meta', 'Meta'], ['cmd', 'Meta'], ['command', 'Meta'], ['win', 'Meta'], ['super', 'Meta'],
]);

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

const ALLOWED_CODES_LIST = [
  'Backslash', 'Equal', 'Minus', 'Comma', 'Period', 'Slash', 'Semicolon', 'Quote',
  'BracketLeft', 'BracketRight', 'Backquote', 'Tab', 'Enter', 'Space', 'Backspace',
  'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal',
];
for (let i = 65; i <= 90; i++) ALLOWED_CODES_LIST.push('Key' + String.fromCharCode(i));
for (let i = 0; i <= 9; i++) ALLOWED_CODES_LIST.push('Digit' + i, 'Numpad' + i);
for (let i = 1; i <= 12; i++) ALLOWED_CODES_LIST.push('F' + i);

const CODE_CANONICAL = new Map(ALLOWED_CODES_LIST.map((c) => [c.toLowerCase(), c]));
CODE_CANONICAL.set('numpadenter', 'Enter');

const CODE_EQUIV = new Map([
  ['Equal', 'NumpadAdd'], ['NumpadAdd', 'Equal'],
  ['Minus', 'NumpadSubtract'], ['NumpadSubtract', 'Minus'],
  ['Digit0', 'Numpad0'], ['Numpad0', 'Digit0'],
  ['Enter', 'NumpadEnter'], ['NumpadEnter', 'Enter'],
]);

const KEY_LABELS = new Map([
  ['Backslash', '\\'], ['Equal', '='], ['Minus', '−'], ['Comma', ','], ['Period', '.'],
  ['Slash', '/'], ['Semicolon', ';'], ['Quote', "'"], ['BracketLeft', '['],
  ['BracketRight', ']'], ['Backquote', '`'],
  ['Tab', 'Tab'], ['Enter', 'Enter'], ['Space', 'Space'], ['Backspace', 'Backspace'],
  ['Delete', 'Del'], ['Insert', 'Ins'], ['Home', 'Home'], ['End', 'End'],
  ['PageUp', 'PgUp'], ['PageDown', 'PgDn'],
  ['ArrowUp', '↑'], ['ArrowDown', '↓'], ['ArrowLeft', '←'], ['ArrowRight', '→'],
  ['NumpadAdd', 'Num+'], ['NumpadSubtract', 'Num−'], ['NumpadMultiply', 'Num*'],
  ['NumpadDivide', 'Num/'], ['NumpadDecimal', 'Num.'],
]);

const FN_KEY_RE = /^F(?:[1-9]|1[0-2])$/;
const INVALID_MOD_MSG = 'Добавьте Ctrl или Alt (или используйте F1–F12)';

/**
 * Разбирает и нормализует строковую комбинацию. Пустая строка означает отключённый хоткей.
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeCombo(raw) {
  if (raw === '') return '';
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let ctrl = false, alt = false, shift = false, meta = false;
  let code = '';
  for (const seg of trimmed.split('+')) {
    const tok = seg.trim();
    if (!tok) return null;
    const mod = MOD_ALIASES.get(tok.toLowerCase());
    if (mod) {
      if (mod === 'Ctrl') ctrl = true;
      else if (mod === 'Alt') alt = true;
      else if (mod === 'Shift') shift = true;
      else meta = true;
      continue;
    }
    const canon = CODE_CANONICAL.get(tok.toLowerCase());
    if (!canon || code) return null;
    code = canon;
  }

  if (!code) return null;
  const isFn = FN_KEY_RE.test(code);
  const isShiftEnter = shift && !ctrl && !alt && !meta && code === 'Enter';
  if (!isFn && !isShiftEnter && !ctrl && !alt && !meta) return null;

  const out = [];
  if (ctrl) out.push('Ctrl');
  if (alt) out.push('Alt');
  if (shift) out.push('Shift');
  if (meta) out.push('Meta');
  out.push(code);
  return out.join('+');
}

/**
 * Разбирает нормализованную строку в структуру модификаторов и кода клавиши.
 * @param {string} combo
 * @returns {{ ctrl: boolean, alt: boolean, shift: boolean, meta: boolean, code: string } | null}
 */
function parseCombo(combo) {
  const norm = normalizeCombo(combo);
  if (!norm) return null;
  const parts = norm.split('+');
  const code = parts.pop() || '';
  return {
    ctrl: parts.includes('Ctrl'),
    alt: parts.includes('Alt'),
    shift: parts.includes('Shift'),
    meta: parts.includes('Meta'),
    code,
  };
}

/**
 * Проверяет допустимость комбинации для конкретного действия.
 * @param {string} actionId
 * @param {unknown} combo
 * @returns {{ ok: true, combo: string } | { ok: false, reason: string }}
 */
function validateHotkeyForAction(actionId, combo) {
  if (combo === '') return { ok: true, combo: '' };
  const norm = normalizeCombo(combo);
  if (norm === null) return { ok: false, reason: INVALID_MOD_MSG };
  const def = HOTKEY_BY_ID.get(actionId);
  if (def && def.scope === 'app' && (norm === 'Ctrl+KeyC' || norm === 'Ctrl+KeyV')) {
    return { ok: false, reason: 'Ctrl+C и Ctrl+V зарезервированы терминалом' };
  }
  return { ok: true, combo: norm };
}

/**
 * Преобразует событие клавиатуры в каноническую комбинацию или статус записи.
 * @param {{ code?: string, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, metaKey?: boolean }} e
 * @returns {{ status: 'modifier' } | { status: 'cancel' } | { status: 'ok', combo: string } | { status: 'invalid', reason: string }}
 */
function eventToCombo(e) {
  if (!e || !e.code) return { status: 'invalid', reason: INVALID_MOD_MSG };
  if (MODIFIER_CODES.has(e.code)) return { status: 'modifier' };
  if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return { status: 'cancel' };

  const code = e.code === 'NumpadEnter' ? 'Enter' : e.code;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(code);

  const norm = normalizeCombo(parts.join('+'));
  if (!norm) return { status: 'invalid', reason: INVALID_MOD_MSG };
  return { status: 'ok', combo: norm };
}

/**
 * Возвращает полный словарь активных хоткеев: переопределения поверх дефолтов.
 * Битые значения игнорируются, пустая строка '' означает отключённый хоткей.
 * @param {Record<string, unknown> | null | undefined} overrides
 * @returns {Record<string, string>}
 */
function resolveHotkeys(overrides) {
  const src = overrides && typeof overrides === 'object' ? overrides : {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const def of HOTKEY_DEFS) {
    if (Object.prototype.hasOwnProperty.call(src, def.id)) {
      const val = src[def.id];
      if (val === '') { out[def.id] = ''; continue; }
      const v = validateHotkeyForAction(def.id, val);
      if (v.ok) { out[def.id] = v.combo; continue; }
    }
    out[def.id] = def.defaultCombo;
  }
  return out;
}

/**
 * Возвращает активную комбинацию для действия из объекта настроек ('' если отключено).
 * @param {{ hotkeys?: Record<string, unknown> } | null | undefined} settings
 * @param {string} actionId
 * @returns {string}
 */
function getHotkey(settings, actionId) {
  const def = HOTKEY_BY_ID.get(actionId);
  if (!def) return '';
  const ov = settings && settings.hotkeys;
  if (ov && typeof ov === 'object' && Object.prototype.hasOwnProperty.call(ov, actionId)) {
    const v = validateHotkeyForAction(actionId, ov[actionId]);
    if (v.ok) return v.combo;
  }
  return def.defaultCombo;
}

/**
 * Проверяет, совпадает ли KeyboardEvent с указанной комбинацией.
 * @param {{ code?: string, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, metaKey?: boolean } | null | undefined} e
 * @param {string} combo
 * @param {{ allowMetaAsCtrl?: boolean }} [opts]
 * @returns {boolean}
 */
function matchesCombo(e, combo, opts = {}) {
  if (!e || !combo) return false;
  const parsed = parseCombo(combo);
  if (!parsed) return false;
  const allowMeta = !!opts.allowMetaAsCtrl && parsed.ctrl && !parsed.meta;
  const ctrlHit = allowMeta ? (Boolean(e.ctrlKey) || Boolean(e.metaKey)) : (Boolean(e.ctrlKey) === parsed.ctrl);
  const metaHit = allowMeta ? (Boolean(e.ctrlKey) && Boolean(e.metaKey)) : Boolean(e.metaKey);
  if (!ctrlHit || metaHit !== parsed.meta) return false;
  if (Boolean(e.altKey) !== parsed.alt || Boolean(e.shiftKey) !== parsed.shift) return false;
  return e.code === parsed.code || CODE_EQUIV.get(parsed.code) === e.code;
}

/**
 * Проверяет срабатывание настроенного действия по событию клавиатуры.
 * @param {{ code?: string, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, metaKey?: boolean } | null | undefined} e
 * @param {{ hotkeys?: Record<string, unknown> } | null | undefined} settings
 * @param {string} actionId
 * @param {{ allowMetaAsCtrl?: boolean }} [opts]
 * @returns {boolean}
 */
function matchesAction(e, settings, actionId, opts) {
  return matchesCombo(e, getHotkey(settings, actionId), opts);
}

/**
 * Находит действия в том же scope, уже использующие заданную комбинацию.
 * @param {Record<string, unknown> | null | undefined} overrides
 * @param {string} actionId
 * @param {string} combo
 * @returns {HotkeyDef[]}
 */
function findConflicts(overrides, actionId, combo) {
  const target = HOTKEY_BY_ID.get(actionId);
  const p = parseCombo(combo);
  if (!target || !p) return [];
  const resolved = resolveHotkeys(overrides);
  const out = [];
  for (const def of HOTKEY_DEFS) {
    if (def.id === actionId || def.scope !== target.scope) continue;
    const other = parseCombo(resolved[def.id]);
    if (!other) continue;
    if (other.ctrl !== p.ctrl || other.alt !== p.alt || other.shift !== p.shift || other.meta !== p.meta) continue;
    if (other.code === p.code || CODE_EQUIV.get(p.code) === other.code) out.push(def);
  }
  return out;
}

/**
 * Возвращает новый разреженный объект переопределений settings.hotkeys.
 * При совпадении с defaultCombo ключ удаляется.
 * @param {Record<string, unknown> | null | undefined} overrides
 * @param {string} actionId
 * @param {string} combo
 * @returns {Record<string, string>}
 */
function setHotkeyOverride(overrides, actionId, combo) {
  /** @type {Record<string, string>} */
  const next = {};
  const src = overrides && typeof overrides === 'object' ? overrides : {};
  for (const [k, v] of Object.entries(src)) {
    if (HOTKEY_BY_ID.has(k) && typeof v === 'string') next[k] = v;
  }
  const def = HOTKEY_BY_ID.get(actionId);
  if (!def) return next;
  const v = validateHotkeyForAction(actionId, combo);
  if (!v.ok) return next;
  if (v.combo === def.defaultCombo) delete next[actionId];
  else next[actionId] = v.combo;
  return next;
}

/**
 * Преобразует каноническую комбинацию в массив читаемых частей для бейджей `<kbd>`.
 * @param {string} combo
 * @returns {string[]}
 */
function formatComboParts(combo) {
  const p = parseCombo(combo);
  if (!p) return [];
  const parts = [];
  if (p.ctrl) parts.push('Ctrl');
  if (p.alt) parts.push('Alt');
  if (p.shift) parts.push('Shift');
  if (p.meta) parts.push('Meta');

  let keyLabel = KEY_LABELS.get(p.code);
  if (!keyLabel) {
    if (p.code.startsWith('Key')) keyLabel = p.code.slice(3);
    else if (p.code.startsWith('Digit')) keyLabel = p.code.slice(5);
    else if (p.code.startsWith('Numpad')) keyLabel = 'Num' + p.code.slice(6);
    else keyLabel = p.code;
  }
  parts.push(keyLabel);
  return parts;
}

/**
 * Форматирует комбинацию в читаемую строку (`Ctrl+Shift+D`, `Ctrl+\`, `''`).
 * @param {string} combo
 * @returns {string}
 */
function formatCombo(combo) {
  const parts = formatComboParts(combo);
  return parts.length ? parts.join('+') : '';
}

module.exports = {
  HOTKEY_GROUPS,
  HOTKEY_DEFS,
  HOTKEY_BY_ID,
  normalizeCombo,
  validateHotkeyForAction,
  eventToCombo,
  resolveHotkeys,
  getHotkey,
  matchesCombo,
  matchesAction,
  findConflicts,
  setHotkeyOverride,
  formatComboParts,
  formatCombo,
};
