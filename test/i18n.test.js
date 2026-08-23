// Тест ядра локализации (main-процесс): подключаемые словари, английский как база,
// шаблоны с {N}, кэш по mtime. Регрессия здесь ломает интерфейс целиком и молча —
// строки просто перестают переводиться (или, наоборот, тормозят открытие окон, как в v1.1.113).
// Запуск: node test/i18n.test.js  (без зависимостей, чистый node).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ⚠️ Каталог пользовательских локалей вычисляется из homedir() ПРИ ЗАГРУЗКЕ модуля,
// поэтому подменяем HOME до require: иначе тест увидит локали с машины разработчика
// и результат будет зависеть от того, кто его запускает.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-i18n-test-'));
process.env.HOME = HOME;
const USER_LOCALES = path.join(HOME, '.LiteEditorAI', 'locales');
fs.mkdirSync(USER_LOCALES, { recursive: true });

// Пользовательский язык: переведено ЧАСТИЧНО — так проверяется база из английского.
const XX = {
  '@@meta': { name: 'Testish', nativeName: 'Тестиш', rtl: true },
  'Сохранить': 'XX-save',
  'Найдено {0} файлов': 'XX-found {0} files',
  '{0} из {1}': '{1} XX-of {0}',
};
fs.writeFileSync(path.join(USER_LOCALES, 'xx.json'), JSON.stringify(XX), 'utf8');
// Битый файл рядом не должен ронять ни список языков, ни загрузку словаря.
fs.writeFileSync(path.join(USER_LOCALES, 'broken.json'), '{ это не JSON', 'utf8');

const i18n = require('../lib/i18n.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; }

// Строка, гарантированно присутствующая во встроенном английском словаре: берём
// из самого файла, чтобы тест не ломался при редактировании конкретных фраз.
const enDict = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'en.json'), 'utf8'));
const EN_KEY = Object.keys(enDict).find((k) => k !== '@@meta' && !/\{\d\}/.test(k) && !XX[k]);
const EN_VALUE = enDict[EN_KEY];

// --- Русский: исходный язык, работает без файла ----------------------------------
eq(i18n.locale(), 'ru', 'по умолчанию русский');
eq(i18n.t('Сохранить'), 'Сохранить', 'на русском строка возвращается как есть');
eq(i18n.t(EN_KEY), EN_KEY, 'русский не подменяется английским');
eq(i18n.dictionary(), {}, 'для русского словарь пуст');
ok(i18n.isRtl() === false, 'русский слева направо');

// --- Подстановки работают независимо от языка ------------------------------------
eq(i18n.t('Найдено {0}', 3), 'Найдено 3', 'подстановка числа');
eq(i18n.t('{0} из {1}', 'a', 'b'), 'a из b', 'две подстановки по порядку');
eq(i18n.t('{1} и {0}', 'a', 'b'), 'b и a', 'индексы, а не позиции');
eq(i18n.t('Найдено {0}'), 'Найдено {0}', 'без аргументов плейсхолдер не трогаем');
eq(i18n.t('Нет {0}', null), 'Нет ', 'null подставляется пустой строкой');
eq(i18n.t(null), '', 'null вместо строки не роняет');
eq(i18n.t(undefined), '', 'undefined не роняет');
eq(i18n.t(42), '42', 'число приводится к строке');

// --- Встроенный английский --------------------------------------------------------
eq(i18n.setLocale('en'), 'en', 'setLocale возвращает код');
eq(i18n.locale(), 'en', 'язык переключился');
eq(i18n.t(EN_KEY), EN_VALUE, 'строка переводится по словарю');
ok(Object.keys(i18n.dictionary()).length > 1000, 'английский словарь загружен целиком');
ok(i18n.dictionary()['@@meta'] === undefined, 'служебный ключ @@meta в словарь не попадает');

// --- Регистр кода языка не важен ---------------------------------------------------
eq(i18n.setLocale('EN'), 'en', 'код приводится к нижнему регистру');
eq(i18n.setLocale(null), 'ru', 'пустой код → русский');

// --- Пользовательский язык поверх английской базы ----------------------------------
i18n.setLocale('xx');
eq(i18n.t('Сохранить'), 'XX-save', 'строка из пользовательского файла');
eq(i18n.t(EN_KEY), EN_VALUE, 'НЕпереведённая строка показывается по-английски, а не по-русски');
ok(i18n.isRtl() === true, 'rtl из @@meta');

// шаблоны: ключ с {N} матчится регуляркой, а не точным совпадением
eq(i18n.t('Найдено 5 файлов'), 'XX-found 5 files', 'шаблон с подстановкой распознан в готовой строке');
// Шаблон уже подставил значение из самой строки, плейсхолдеров в результате не осталось —
// поэтому переданный следом аргумент никуда не встаёт. Так и задумано: этот вызов означает
// «переведи готовую фразу», а не «собери её заново».
eq(i18n.t('Найдено 5 файлов', 9), 'XX-found 5 files', 'значение берётся из строки, а не из аргумента');
eq(i18n.t('a из b'), 'b XX-of a', 'порядок аргументов в переводе может отличаться');
eq(i18n.t('Совсем другая строка'), 'Совсем другая строка', 'не подошедшая под шаблон строка не портится');

const patterns = i18n.patternList();
ok(patterns.length >= 2, 'шаблоны скомпилированы');
ok(patterns.every((p) => typeof p.source === 'string' && Array.isArray(p.order)), 'шаблон отдаётся как {source, order, out}');

// --- Список языков -----------------------------------------------------------------
const list = i18n.available();
eq(list[0].code, 'ru', 'русский всегда первым');
const codes = list.map((l) => l.code);
ok(codes.includes('en') && codes.includes('zh'), 'встроенные языки в списке');
ok(codes.includes('xx'), 'пользовательский язык в списке');
// Список языков строится по именам файлов, поэтому нечитаемый словарь в нём остаётся:
// важно, что он не роняет разбор остальных.
ok(codes.includes('broken'), 'битый файл виден как язык, но список строится');

const xxMeta = list.find((l) => l.code === 'xx');
eq(xxMeta.name, 'Testish', 'имя языка из @@meta');
eq(xxMeta.nativeName, 'Тестиш', 'самоназвание из @@meta');
ok(xxMeta.rtl === true, 'rtl из @@meta');
ok(xxMeta.builtin === false, 'пользовательский язык не встроенный');

const ruMeta = list.find((l) => l.code === 'ru');
eq(ruMeta.nativeName, 'Русский', 'русский подписан без файла');
ok(ruMeta.builtin === true, 'русский считается встроенным');

const enMeta = list.find((l) => l.code === 'en');
ok(enMeta.builtin === true, 'английский встроенный');

// --- Неизвестный язык: словарь = английская база -------------------------------------
i18n.setLocale('yy');
eq(i18n.t(EN_KEY), EN_VALUE, 'для языка без файла остаётся английский');
ok(i18n.isRtl() === false, 'без @@meta направление обычное');

// --- Кэш по mtime: правка файла подхватывается ----------------------------------------
// Кэш держит разобранный JSON, пока совпадают mtime и размер. Если инвалидация сломается,
// пользователь будет править свой словарь и не видеть изменений до перезапуска.
const XX2 = { ...XX, 'Сохранить': 'XX-save-EDITED-LONGER' };
fs.writeFileSync(path.join(USER_LOCALES, 'xx.json'), JSON.stringify(XX2), 'utf8');
i18n.setLocale('xx');
eq(i18n.t('Сохранить'), 'XX-save-EDITED-LONGER', 'изменённый файл словаря перечитан');

// --- Битый JSON не ломает ничего --------------------------------------------------------
i18n.setLocale('broken');
eq(i18n.t(EN_KEY), EN_VALUE, 'при нечитаемом файле остаётся английская база');
ok(Array.isArray(i18n.available()), 'список языков строится и с битым файлом');

// --- Каталоги отдаются наружу (main показывает их в настройках) --------------------------
eq(i18n.USER_DIR, USER_LOCALES, 'USER_DIR указывает в каталог пользователя');
ok(fs.existsSync(i18n.BUILTIN_DIR), 'BUILTIN_DIR существует');

// --- Сортировка списка: русский первым, остальные по алфавиту -----------------------
const codesOrdered = i18n.available().map((l) => l.code);
eq(codesOrdered[0], 'ru', 'русский закреплён первым');
const rest = codesOrdered.slice(1);
eq(rest, [...rest].sort(), 'остальные языки по алфавиту');
eq(i18n.available().map((l) => l.code).filter((c) => c === 'ru').length, 1, 'русский в списке один раз');

// Имена встроенных языков подставляются, даже если в файле нет @@meta.
const zhMeta = i18n.available().find((l) => l.code === 'zh');
eq(zhMeta.nativeName, '简体中文', 'самоназвание китайского');
const enMetaFull = i18n.available().find((l) => l.code === 'en');
eq(enMetaFull.name, 'English', 'имя английского');
eq(enMetaFull.nativeName, 'English', 'самоназвание английского');

// Имена файлов вне формата «код языка» языками не считаются.
fs.writeFileSync(path.join(USER_LOCALES, '1bad.json'), '{}', 'utf8');
fs.writeFileSync(path.join(USER_LOCALES, 'слишком-длинный-код-языка.json'), '{}', 'utf8');
fs.writeFileSync(path.join(USER_LOCALES, 'notes.txt'), 'x', 'utf8');
const codes2 = i18n.available().map((l) => l.code);
ok(!codes2.includes('1bad'), 'код не может начинаться с цифры');
ok(!codes2.some((c) => c.length > 16), 'слишком длинное имя файла не язык');
ok(!codes2.includes('notes'), 'не-json игнорируется');

// Регистр в имени файла приводится к нижнему — иначе один язык попал бы в список дважды.
fs.writeFileSync(path.join(USER_LOCALES, 'DE.json'), JSON.stringify({ 'Сохранить': 'Speichern' }), 'utf8');
const codes3 = i18n.available().map((l) => l.code);
ok(codes3.includes('de'), 'DE.json даёт код de');
eq(codes3.filter((c) => c.toLowerCase() === 'de').length, 1, 'без дублей по регистру');

// --- Только шаблонные ключи компилируются в регулярки --------------------------------
i18n.setLocale('xx');
const sources = i18n.patternList().map((p) => p.source);
ok(sources.every((s) => s.includes('([\\s\\S]*?)')), 'в шаблон попали только ключи с подстановкой');
// Словарь строится поверх английской базы, поэтому шаблонов много — важно, что оба
// ключа с {N} из пользовательского файла среди них есть, а ключ без {N} — нет.
const outs = i18n.patternList().map((p) => p.out);
ok(outs.includes('XX-found {0} files') && outs.includes('{1} XX-of {0}'), 'шаблоны пользовательского словаря скомпилированы');
ok(!outs.includes('XX-save'), 'ключ без подстановок в шаблоны не попал');

// Спецсимволы регулярок в ключе экранируются — иначе ключ «Найдено (1) шт.» стал бы группой.
fs.writeFileSync(path.join(USER_LOCALES, 'zz.json'), JSON.stringify({
  'Файл (копия {0}).txt': 'Copy {0} of file',
  'a.b {0}': 'dot {0}',
}), 'utf8');
i18n.setLocale('zz');
eq(i18n.t('Файл (копия 2).txt'), 'Copy 2 of file', 'скобки в ключе — литералы, а не группа');
eq(i18n.t('aXb 7'), 'aXb 7', 'точка в ключе не матчит произвольный символ');

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`✓ i18n: ${passed} проверок пройдено`);
