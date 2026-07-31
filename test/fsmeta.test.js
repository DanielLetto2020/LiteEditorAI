// Тест метаданных файлов удалённого хоста (права/владелец/дата в модуле «Удалённые хосты»).
// Запуск: node test/fsmeta.test.js
const assert = require('assert');
const { fileTypeChar, isDirMode, isLinkMode, permsFromMode, modeOctal, parseLongname, permsFromFtp, toMillis } = require('../lib/fsmeta.js');

// ---- тип узла из mode
assert.strictEqual(fileTypeChar(0o100644), '-');   // обычный файл
assert.strictEqual(fileTypeChar(0o040755), 'd');   // каталог
assert.strictEqual(fileTypeChar(0o120777), 'l');   // симлинк
assert.strictEqual(fileTypeChar(0o010600), 'p');   // FIFO
assert.strictEqual(fileTypeChar(0o140755), 's');   // сокет
assert.strictEqual(fileTypeChar(0o020600), 'c');   // символьное устройство
assert.strictEqual(fileTypeChar(0o060600), 'b');   // блочное устройство
assert.strictEqual(fileTypeChar(0o000644), '');    // тип не задан — не выдумываем '-'
assert.strictEqual(fileTypeChar(undefined), '');
assert.strictEqual(fileTypeChar(null), '');
assert.strictEqual(fileTypeChar('0100644'), '');   // строка — не mode

assert.strictEqual(isDirMode(0o040755), true);
assert.strictEqual(isDirMode(0o100644), false);
assert.strictEqual(isDirMode(undefined), false);
assert.strictEqual(isLinkMode(0o120777), true);
assert.strictEqual(isLinkMode(0o040755), false);
assert.strictEqual(isLinkMode(null), false);

// ---- права строкой
assert.strictEqual(permsFromMode(0o100644), 'rw-r--r--');
assert.strictEqual(permsFromMode(0o040755), 'rwxr-xr-x');
assert.strictEqual(permsFromMode(0o100600), 'rw-------');
assert.strictEqual(permsFromMode(0o100777), 'rwxrwxrwx');
assert.strictEqual(permsFromMode(0o100000), '---------');
// спецбиты: setuid/setgid при наличии x → s, без x → S; sticky → t/T
assert.strictEqual(permsFromMode(0o104755), 'rwsr-xr-x');   // setuid + x
assert.strictEqual(permsFromMode(0o104644), 'rwSr--r--');   // setuid без x
assert.strictEqual(permsFromMode(0o102755), 'rwxr-sr-x');   // setgid + x
assert.strictEqual(permsFromMode(0o102644), 'rw-r-Sr--');   // setgid без x
assert.strictEqual(permsFromMode(0o041777), 'rwxrwxrwt');   // /tmp: sticky + x
assert.strictEqual(permsFromMode(0o041666), 'rw-rw-rwT');   // sticky без x
assert.strictEqual(permsFromMode(undefined), '');
assert.strictEqual(permsFromMode(NaN), '');

// ---- восьмеричный вид
assert.strictEqual(modeOctal(0o100644), '0644');
assert.strictEqual(modeOctal(0o040755), '0755');
assert.strictEqual(modeOctal(0o104755), '4755');   // спецбиты сохраняются
assert.strictEqual(modeOctal(0o041777), '1777');
assert.strictEqual(modeOctal(0o100000), '0000');
assert.strictEqual(modeOctal(null), '');

// ---- longname из SFTP (формат `ls -l`)
let r = parseLongname('-rw-r--r--   1 root     www-data     1234 Jul 30 10:00 file.txt');
assert.deepStrictEqual(r, { type: '-', perms: 'rw-r--r--', owner: 'root', group: 'www-data' });
r = parseLongname('drwxr-xr-x   4 maxim    maxim        4096 Jul 30 10:00 projects');
assert.strictEqual(r.type, 'd');
assert.strictEqual(r.owner, 'maxim');
// SELinux/ACL-суффикс после прав («.» или «+») не должен ломать разбор
r = parseLongname('-rw-r--r--. 1 nginx nginx 55 Jan  1 00:00 index.html');
assert.strictEqual(r.owner, 'nginx');
assert.strictEqual(r.group, 'nginx');
r = parseLongname('-rw-rw-r--+ 1 deploy web 55 Jan  1 00:00 app.log');
assert.strictEqual(r.perms, 'rw-rw-r--');
// спецбиты в правах распознаются
r = parseLongname('-rwsr-xr-x 1 root root 68208 Feb 10 2025 sudo');
assert.strictEqual(r.perms, 'rwsr-xr-x');
// цифровые uid/gid (нет /etc/passwd в контейнере) — тоже владелец и группа
r = parseLongname('-rw-r--r-- 1 1000 1000 12 Jan  1 00:00 x');
assert.strictEqual(r.owner, '1000');
// нераспознанное → null, без исключений
assert.strictEqual(parseLongname('file.txt'), null);
assert.strictEqual(parseLongname(''), null);
assert.strictEqual(parseLongname(null), null);
assert.strictEqual(parseLongname('-rw-r--r-- root root 12 Jan 1 00:00 x'), null); // нет колонки ссылок

// ---- права из FTP-битов
assert.strictEqual(permsFromFtp({ user: 6, group: 4, world: 4 }), 'rw-r--r--');
assert.strictEqual(permsFromFtp({ user: 7, group: 5, world: 5 }), 'rwxr-xr-x');
assert.strictEqual(permsFromFtp({ user: 0, group: 0, world: 0 }), '---------');
assert.strictEqual(permsFromFtp({ user: 6 }), 'rw-------');       // неполные данные — остальное пусто
assert.strictEqual(permsFromFtp({}), '');                          // объект без битов — данных нет
assert.strictEqual(permsFromFtp(null), '');
assert.strictEqual(permsFromFtp(undefined), '');
assert.strictEqual(permsFromFtp('rwxr-xr-x'), '');                 // строка — не биты

// ---- время: SFTP отдаёт секунды, basic-ftp — Date
assert.strictEqual(toMillis(1753900000), 1753900000000);
assert.strictEqual(toMillis(1753900000000), 1753900000000);
assert.strictEqual(toMillis(new Date(1753900000000)), 1753900000000);
assert.strictEqual(toMillis(0), null);
assert.strictEqual(toMillis(-5), null);
assert.strictEqual(toMillis(null), null);
assert.strictEqual(toMillis(undefined), null);
assert.strictEqual(toMillis('не дата'), null);
assert.strictEqual(toMillis(new Date('нет такой даты')), null);

console.log('fsmeta: ok');
