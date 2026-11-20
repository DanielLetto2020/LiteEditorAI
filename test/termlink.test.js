// Тесты разбора ссылок из терминала (lib/termlink.js): OSC 8 → браузер / вивер / игнор.
// Запуск: node test/termlink.test.js
'use strict';

const assert = require('assert');
const { classifyTermLink, shellQuotePath } = require('../lib/termlink.js');

let passed = 0;
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; }

// web
eq(classifyTermLink('https://example.com/a?b=1#c'), { kind: 'web', url: 'https://example.com/a?b=1#c' }, 'https');
eq(classifyTermLink('http://localhost:3000/'), { kind: 'web', url: 'http://localhost:3000/' }, 'http с портом');
eq(classifyTermLink('  https://example.com  '), { kind: 'web', url: 'https://example.com/' }, 'пробелы по краям');
eq(classifyTermLink('HTTPS://Example.com/X'), { kind: 'web', url: 'https://example.com/X' }, 'регистр схемы');

// file
eq(classifyTermLink('file:///home/u/p/app.js'), { kind: 'file', path: '/home/u/p/app.js', line: 0 }, 'file без хоста');
eq(classifyTermLink('file://my-laptop/home/u/p/app.js'), { kind: 'file', path: '/home/u/p/app.js', line: 0 }, 'file с хостом (ls --hyperlink)');
eq(classifyTermLink('file:///home/u/my%20dir/a.md'), { kind: 'file', path: '/home/u/my dir/a.md', line: 0 }, '%20');
eq(classifyTermLink('file:///home/u/%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82/a.md'), { kind: 'file', path: '/home/u/проект/a.md', line: 0 }, 'кириллица');
eq(classifyTermLink('file:///home/u/проект/a.md'), { kind: 'file', path: '/home/u/проект/a.md', line: 0 }, 'кириллица без кодирования');
eq(classifyTermLink('file:///home/u/a.js#L12'), { kind: 'file', path: '/home/u/a.js', line: 12 }, '#L12');
eq(classifyTermLink('file:///home/u/a.js#42'), { kind: 'file', path: '/home/u/a.js', line: 42 }, '#42');
eq(classifyTermLink('file:///home/u/a.js:7'), { kind: 'file', path: '/home/u/a.js', line: 7 }, ':7');
eq(classifyTermLink('file:///home/u/a.js:7:3'), { kind: 'file', path: '/home/u/a.js', line: 7 }, ':7:3');
eq(classifyTermLink('file:///home/u/a.js#section'), { kind: 'file', path: '/home/u/a.js', line: 0 }, 'нечисловой фрагмент');
eq(classifyTermLink('file:///C:/work/a.ts'), { kind: 'file', path: 'C:/work/a.ts', line: 0 }, 'windows-путь');
eq(classifyTermLink('file:///'), null, 'корень');
eq(classifyTermLink('file:///home/u/bad%E0%A4%A'), null, 'битый %-код');

// игнор
for (const bad of ['mailto:a@b.c', 'javascript:alert(1)', 'ssh://host', 'ftp://x/y', 'vscode://file/a', '', '   ', 'просто текст', '/home/u/a.js', null, undefined, 42]) {
  eq(classifyTermLink(bad), null, 'игнор: ' + String(bad));
}

// shellQuotePath — вставка путей (drop файла, скриншот) в командную строку
eq(shellQuotePath('/home/u/p/shot-1.png'), '/home/u/p/shot-1.png', 'простой путь без кавычек');
eq(shellQuotePath('/home/u/my dir/a.png'), "'/home/u/my dir/a.png'", 'пробел');
eq(shellQuotePath("/home/u/it's"), "'/home/u/it'\\''s'", 'апостроф');
eq(shellQuotePath('/home/u/проект/a.md'), "'/home/u/проект/a.md'", 'кириллица — в кавычках');
eq(shellQuotePath('~/x'), "'~/x'", 'тильда не раскрывается');
eq(shellQuotePath('/a/$(rm -rf ~)'), "'/a/$(rm -rf ~)'", 'подстановка команды обезврежена');
eq(shellQuotePath(''), "''", 'пустая строка');

console.log(`✓ termlink: ${passed} проверок пройдено`);
