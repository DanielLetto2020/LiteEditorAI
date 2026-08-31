// Тест нормализации текста для озвучки (модуль «Озвучка»).
// Запуск: node test/ttsnorm.test.js
// Почему это важно: Silero не читает цифры и падает с пустым ValueError на фразе без кириллицы —
// оба случая проверены на живом движке, см. docs/TTS_VOICE.md.
const assert = require('assert');
const { normalizeForSpeech, hasSpeakable, numberToWords, plural } = require('../lib/ttsnorm.js');

let checks = 0;
const eq = (got, want, what) => { assert.strictEqual(got, want, `${what}: получено «${got}», ожидалось «${want}»`); checks++; };
const has = (text, part, what) => { assert.ok(String(text).includes(part), `${what}: в «${text}» нет «${part}»`); checks++; };

// ── числительные ──────────────────────────────────────────────────────────────
eq(numberToWords(0), 'ноль', '0');
eq(numberToWords(1), 'один', '1');
eq(numberToWords(11), 'одиннадцать', '11');
eq(numberToWords(21), 'двадцать один', '21');
eq(numberToWords(100), 'сто', '100');
eq(numberToWords(192), 'сто девяносто два', '192');
eq(numberToWords(1000), 'одна тысяча', '1000 — тысяча женского рода');
eq(numberToWords(2000), 'две тысячи', '2000');
eq(numberToWords(2026), 'две тысячи двадцать шесть', '2026');
eq(numberToWords(21000), 'двадцать одна тысяча', '21000');
eq(numberToWords(5000), 'пять тысяч', '5000');
eq(numberToWords(1000000), 'один миллион', 'миллион');
eq(numberToWords(2500000), 'два миллиона пятьсот тысяч', '2 500 000');
eq(numberToWords(-7), 'минус семь', 'отрицательное');
eq(numberToWords(3, true), 'три', 'женский род не портит прочие числа');

// формы существительного по числу
eq(plural(1, 'файл', 'файла', 'файлов'), 'файл', 'plural 1');
eq(plural(3, 'файл', 'файла', 'файлов'), 'файла', 'plural 3');
eq(plural(11, 'файл', 'файла', 'файлов'), 'файлов', 'plural 11');
eq(plural(22, 'файл', 'файла', 'файлов'), 'файла', 'plural 22');

// ── числа в тексте (главный баг: цифры проглатывались) ────────────────────────
eq(normalizeForSpeech('Обработано 15 файлов и 3 проекта.'),
  'Обработано пятнадцать файлов и три проекта.', 'числа в предложении');
eq(normalizeForSpeech('В 2026 году'), 'В две тысячи двадцать шесть году', 'год');
has(normalizeForSpeech('Версия 1.1.192 собрана'), 'один точка один точка сто девяносто два', 'версия');
has(normalizeForSpeech('Готово на 98%'), 'девяносто восемь процентов', 'проценты');
has(normalizeForSpeech('Осталось 1%'), 'один процент', 'один процент — единственное число');
has(normalizeForSpeech('Осталось 2%'), 'два процента', 'два процента');
has(normalizeForSpeech('Модель 39 МБ'), 'тридцать девять мегабайт', 'единицы измерения');
has(normalizeForSpeech('Сборка 1.4 МБ'), 'один точка четыре мегабайта', 'дробное число с единицей');
has(normalizeForSpeech('Готово на 99.5%'), 'девяносто девять точка пять процента', 'дробные проценты — родительный падеж');
has(normalizeForSpeech('Заняло 250 мс'), 'двести пятьдесят миллисекунд', 'миллисекунды');
has(normalizeForSpeech('Скорость 3.5 раза'), 'три точка пять', 'дробное через точку');
has(normalizeForSpeech('Скорость 3,5 раза'), 'три точка пять', 'дробное через запятую');
has(normalizeForSpeech('Встреча в 12:30'), 'двенадцать тридцать', 'время');
has(normalizeForSpeech('Всего 1 234 файла'), 'одна тысяча двести тридцать четыре', 'разделитель разрядов пробелом');
has(normalizeForSpeech('Всего 1,234 файла'), 'одна тысяча двести тридцать четыре', 'разделитель разрядов запятой');

// ── латиница (движок её не читает вовсе) ──────────────────────────────────────
has(normalizeForSpeech('файл ok'), 'окей', 'частый термин из словаря');
has(normalizeForSpeech('ошибка JSON'), 'джейсон', 'термин в верхнем регистре');
has(normalizeForSpeech('запрос API'), 'эй пи ай', 'аббревиатура по буквам');
eq(/[A-Za-z]/.test(normalizeForSpeech('LiteEditor build ok')), false, 'латиницы не остаётся');
eq(/[A-Za-z]/.test(normalizeForSpeech('Смотри renderer/modules/voice.js строка 120')), false,
  'латиницы не остаётся и в пути');

// ── защита от падения движка ──────────────────────────────────────────────────
// Всё это роняло Silero пустым ValueError и обрывало чтение всего текста.
eq(hasSpeakable(normalizeForSpeech('1.1.192')), true, 'версия становится произносимой');
eq(hasSpeakable(normalizeForSpeech('LiteEditor build ok')), true, 'латиница становится произносимой');
eq(hasSpeakable(normalizeForSpeech('(1)')), true, 'скобка с цифрой становится произносимой');
eq(hasSpeakable(normalizeForSpeech('   ')), false, 'пустая строка непроизносима');
eq(hasSpeakable(normalizeForSpeech('— …')), false, 'одна пунктуация непроизносима');
eq(hasSpeakable(normalizeForSpeech('***')), false, 'разделитель непроизносим');

// ── ничего лишнего не ломаем ──────────────────────────────────────────────────
eq(normalizeForSpeech('Обычный текст без чисел.'), 'Обычный текст без чисел.', 'чистый русский текст не меняется');
eq(normalizeForSpeech('з+амок'), 'з+амок', 'расставленное ударение сохраняется');
eq(normalizeForSpeech(''), '', 'пустой вход');
eq(normalizeForSpeech(null), '', 'null не роняет');

console.log(`✓ ttsnorm: ${checks} проверок пройдено`);
