// Тесты реестра, нормализации, сопоставления и конфликтов горячих клавиш (lib/hotkeys.js).
// Запуск: node test/hotkeys.test.js
'use strict';

const assert = require('assert');
const {
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
} = require('../lib/hotkeys');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; }

// 1. Целостность реестра HOTKEY_DEFS и отсутствие дефолтных конфликтов
const seenIds = new Set();
const groupIds = new Set(HOTKEY_GROUPS.map((g) => g.id));
for (const def of HOTKEY_DEFS) {
  ok(!seenIds.has(def.id), `уникальный id: ${def.id}`);
  seenIds.add(def.id);
  ok(groupIds.has(def.group), `группа существует для ${def.id}`);
  eq(HOTKEY_BY_ID.get(def.id), def, `HOTKEY_BY_ID содержит ${def.id}`);
  ok(normalizeCombo(def.defaultCombo) === def.defaultCombo, `дефолт ${def.id} уже в канонической форме`);
  eq(findConflicts({}, def.id, def.defaultCombo), [], `нет дефолтного конфликта для ${def.id}`);
}

// 2. normalizeCombo: порядок модификаторов, NumpadEnter, ограничения безопасности
eq(normalizeCombo('shift+ctrl+keyd'), 'Ctrl+Shift+KeyD', 'канонический порядок модификаторов и регистр');
eq(normalizeCombo('meta+alt+ctrl+shift+keyk'), 'Ctrl+Alt+Shift+Meta+KeyK', 'все 4 модификатора в строгом порядке');
eq(normalizeCombo('ctrl+numpadenter'), 'Ctrl+Enter', 'NumpadEnter → Enter');
eq(normalizeCombo(''), '', 'пустая строка остаётся пустой (отключённый хоткей)');
eq(normalizeCombo('F4'), 'F4', 'F-клавиша допустима без модификаторов');
eq(normalizeCombo('Shift+Enter'), 'Shift+Enter', 'Shift+Enter допустим без Ctrl/Alt');
eq(normalizeCombo('KeyK'), null, 'голая буква без модификаторов запрещена');
eq(normalizeCombo('Shift+KeyK'), null, 'Shift+буква без Ctrl/Alt/Meta запрещена');
eq(normalizeCombo('Digit1'), null, 'голая цифра запрещена');
eq(normalizeCombo('Enter'), null, 'голый Enter запрещён');
eq(normalizeCombo('Escape'), null, 'Escape запрещён');
eq(normalizeCombo('Ctrl+Escape'), null, 'Ctrl+Escape запрещён');
eq(normalizeCombo('ControlLeft'), null, 'чистый модификатор запрещён');
eq(normalizeCombo('Ctrl+KeyA+KeyB'), null, 'две основные клавиши запрещены');

// 3. validateHotkeyForAction: защита Ctrl+C / Ctrl+V в scope 'app'
eq(validateHotkeyForAction('palette', ''), { ok: true, combo: '' }, 'отключение допустимо');
eq(validateHotkeyForAction('palette', 'ctrl+keyc').ok, false, 'Ctrl+C запрещён в app');
eq(validateHotkeyForAction('palette', 'Ctrl+KeyV').ok, false, 'Ctrl+V запрещён в app');
eq(validateHotkeyForAction('palette', 'KeyK').ok, false, 'голая буква отклонена');
eq(validateHotkeyForAction('palette', 'shift+ctrl+keyp'), { ok: true, combo: 'Ctrl+Shift+KeyP' }, 'нормализует допустимое сочетание');

// 4. eventToCombo: запись клавиш
eq(eventToCombo({ code: 'ControlLeft', ctrlKey: true }), { status: 'modifier' }, 'чистый модификатор → modifier');
eq(eventToCombo({ code: 'Escape', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }), { status: 'cancel' }, 'Escape → cancel');
eq(eventToCombo({ code: 'KeyA', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }).status, 'invalid', 'голая буква → invalid');
eq(eventToCombo({ code: 'KeyD', ctrlKey: true, shiftKey: true }), { status: 'ok', combo: 'Ctrl+Shift+KeyD' }, 'Ctrl+Shift+KeyD → ok');
eq(eventToCombo({ code: 'NumpadEnter', ctrlKey: true }), { status: 'ok', combo: 'Ctrl+Enter' }, 'Ctrl+NumpadEnter → Ctrl+Enter');

// 5. matchesCombo / matchesAction: точное совпадение, Numpad-эквиваленты, allowMetaAsCtrl, отключённый хоткей
ok(matchesCombo({ code: 'KeyK', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }, 'Ctrl+KeyK'), 'Ctrl+KeyK совпадает');
ok(!matchesCombo({ code: 'KeyK', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }, 'Ctrl+KeyK'), 'Ctrl+Shift+KeyK НЕ совпадает с Ctrl+KeyK');
ok(matchesCombo({ code: 'NumpadAdd', ctrlKey: true }, 'Ctrl+Equal'), 'NumpadAdd совпадает с Ctrl+Equal');
ok(matchesCombo({ code: 'NumpadSubtract', ctrlKey: true }, 'Ctrl+Minus'), 'NumpadSubtract совпадает с Ctrl+Minus');
ok(matchesCombo({ code: 'Numpad0', ctrlKey: true }, 'Ctrl+Digit0'), 'Numpad0 совпадает с Ctrl+Digit0');
ok(matchesCombo({ code: 'NumpadEnter', ctrlKey: true }, 'Ctrl+Enter'), 'NumpadEnter совпадает с Ctrl+Enter');
ok(matchesCombo({ code: 'KeyP', metaKey: true, ctrlKey: false }, 'Ctrl+KeyP', { allowMetaAsCtrl: true }), 'Meta как Ctrl при allowMetaAsCtrl');
ok(!matchesCombo({ code: 'KeyP', metaKey: true, ctrlKey: true }, 'Ctrl+KeyP', { allowMetaAsCtrl: true }), 'Ctrl+Meta не матчит одиночный Ctrl');
ok(!matchesCombo({ code: 'KeyK', ctrlKey: true }, ''), 'пустая комбинация никогда не срабатывает');

const customSettings = { hotkeys: { palette: 'Alt+KeyP', toggleSingle: '' } };
ok(matchesAction({ code: 'KeyP', altKey: true }, customSettings, 'palette'), 'переопределённый хоткей срабатывает');
ok(!matchesAction({ code: 'KeyK', ctrlKey: true }, customSettings, 'palette'), 'старый дефолт не срабатывает после переопределения');
ok(!matchesAction({ code: 'Backslash', ctrlKey: true }, customSettings, 'toggleSingle'), 'отключённый хоткей не срабатывает');
eq(getHotkey(customSettings, 'palette'), 'Alt+KeyP', 'getHotkey возвращает переопределение');
eq(getHotkey(customSettings, 'toggleSingle'), '', 'getHotkey возвращает пустоту для отключённого');
eq(getHotkey(customSettings, 'termSearch'), 'Ctrl+KeyF', 'getHotkey возвращает дефолт');

// 6. resolveHotkeys: устойчивость к битым значениям
const resolved = resolveHotkeys({
  palette: 'Alt+KeyP',
  toggleSingle: '',
  termSearch: 'KeyF',       // битый (без Ctrl/Alt) → откат к дефолту
  openFiles: 'Ctrl+KeyC',   // запрещённый в app → откат к дефолту
  fontUp: 123,              // не строка → откат к дефолту
  unknownAction: 'Ctrl+KeyQ',
});
eq(resolved.palette, 'Alt+KeyP', 'валидное переопределение сохраняется');
eq(resolved.toggleSingle, '', 'отключение сохраняется');
eq(resolved.termSearch, 'Ctrl+KeyF', 'битое значение откатывается на дефолт');
eq(resolved.openFiles, 'Ctrl+Shift+KeyE', 'Ctrl+C в app откатывается на дефолт');
eq(resolved.fontUp, 'Ctrl+Equal', 'не-строка откатывается на дефолт');
eq(resolved.unknownAction, undefined, 'неизвестные id не попадают в resolved');

// 7. findConflicts: изоляция по scope
eq(findConflicts({}, 'palette', 'Ctrl+KeyF').map((d) => d.id), ['termSearch'], 'конфликт внутри app');
eq(findConflicts({}, 'palette', 'Ctrl+NumpadAdd').map((d) => d.id), ['fontUp'], 'конфликт по Numpad-эквиваленту внутри app');
eq(findConflicts({}, 'files.quickOpen', 'Ctrl+KeyS').map((d) => d.id), ['files.save'], 'конфликт внутри files');
eq(findConflicts({}, 'palette', 'Ctrl+KeyP'), [], 'Ctrl+KeyP в app не конфликтует с files.quickOpen');
eq(findConflicts({}, 'files.splitRight', 'Ctrl+Backslash'), [], 'пересечение с другим scope не считается конфликтом');
eq(findConflicts({}, 'palette', ''), [], 'пустая комбинация не конфликтует');

// 8. setHotkeyOverride: разреженное хранение
const ov1 = setHotkeyOverride({}, 'palette', 'Alt+KeyP');
eq(ov1, { palette: 'Alt+KeyP' }, 'отличие записывается');
const ov2 = setHotkeyOverride(ov1, 'palette', 'Ctrl+KeyK');
eq(ov2, {}, 'возврат к дефолту удаляет ключ');
const ov3 = setHotkeyOverride(ov1, 'toggleSingle', '');
eq(ov3, { palette: 'Alt+KeyP', toggleSingle: '' }, 'отключение сохраняется как ""');

// 9. formatComboParts / formatCombo
eq(formatComboParts('Ctrl+Backslash'), ['Ctrl', '\\'], 'части Ctrl+\\');
eq(formatCombo('Ctrl+Backslash'), 'Ctrl+\\', 'Ctrl+Backslash → Ctrl+\\');
eq(formatCombo('Ctrl+KeyK'), 'Ctrl+K', 'Ctrl+KeyK → Ctrl+K');
eq(formatCombo('Ctrl+PageDown'), 'Ctrl+PgDn', 'Ctrl+PageDown → Ctrl+PgDn');
eq(formatCombo('Alt+ArrowLeft'), 'Alt+←', 'Alt+ArrowLeft → Alt+←');
eq(formatCombo(''), '', 'пустая строка → ""');

console.log(`hotkeys.test.js: OK (${passed} assertions)`);
