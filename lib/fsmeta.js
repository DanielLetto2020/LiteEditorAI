// Метаданные файлов удалённого хоста (модуль «Удалённые хосты»): разбор POSIX-mode,
// строки `ls -l` из SFTP-longname и битов прав FTP-листинга в единый вид для UI.
// Чистые функции без ввода-вывода — сюда же смотрят тесты (test/fsmeta.test.js).
//
// Источники данных различаются по протоколу:
//   SFTP (ssh2)  — attrs.mode (число), плюс longname в формате `ls -l` (оттуда владелец/группа);
//   FTP (basic-ftp) — permissions {user, group, world} битами Read=4/Write=2/Execute=1.

const S_IFMT = 0o170000;
// Тип узла символом первой позиции `ls -l`.
const TYPE_CHARS = {
  0o140000: 's', // socket
  0o120000: 'l', // symlink
  0o100000: '-', // regular file
  0o060000: 'b', // block device
  0o040000: 'd', // directory
  0o020000: 'c', // character device
  0o010000: 'p', // FIFO
};

/** Символ типа узла из POSIX-mode ('d', '-', 'l', …); неизвестный/пустой mode → ''. */
function fileTypeChar(mode) {
  if (!Number.isFinite(mode)) return '';
  return TYPE_CHARS[mode & S_IFMT] || '';
}
function isDirMode(mode) { return Number.isFinite(mode) && (mode & S_IFMT) === 0o040000; }
function isLinkMode(mode) { return Number.isFinite(mode) && (mode & S_IFMT) === 0o120000; }

// Одна тройка rwx с учётом спецбита (setuid/setgid/sticky): x+спецбит → s/t, без x → S/T.
function triplet(bits, special, specialChar) {
  const r = (bits & 4) ? 'r' : '-';
  const w = (bits & 2) ? 'w' : '-';
  const x = special
    ? ((bits & 1) ? specialChar : specialChar.toUpperCase())
    : ((bits & 1) ? 'x' : '-');
  return r + w + x;
}

/** POSIX-mode → 'rwxr-xr-x' (9 символов, без типа). Нечисловой mode → ''. */
function permsFromMode(mode) {
  if (!Number.isFinite(mode)) return '';
  return triplet((mode >> 6) & 7, !!(mode & 0o4000), 's')
    + triplet((mode >> 3) & 7, !!(mode & 0o2000), 's')
    + triplet(mode & 7, !!(mode & 0o1000), 't');
}

/** POSIX-mode → '0644' (спецбиты в старшем разряде: '4755'). Нечисловой mode → ''. */
function modeOctal(mode) {
  if (!Number.isFinite(mode)) return '';
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

/**
 * Строка SFTP-longname (формат `ls -l`) → { perms, owner, group }.
 * Пример: '-rw-r--r--   1 root     www-data     1234 Jul 30 10:00 file.txt'.
 * Не распознали — null (у части серверов longname пустой или нестандартный).
 */
function parseLongname(longname) {
  const m = String(longname || '').match(/^([-dlbcps])([rwxsStT-]{9})[.+]?\s+\d+\s+(\S+)\s+(\S+)\s/);
  if (!m) return null;
  return { type: m[1], perms: m[2], owner: m[3], group: m[4] };
}

/** FTP-биты прав { user, group, world } → 'rwxr-xr-x'; нет данных → ''. */
function permsFromFtp(p) {
  if (!p || typeof p !== 'object') return '';
  const one = (bits) => {
    const b = Number(bits) || 0;
    return ((b & 4) ? 'r' : '-') + ((b & 2) ? 'w' : '-') + ((b & 1) ? 'x' : '-');
  };
  if (p.user == null && p.group == null && p.world == null) return '';
  return one(p.user) + one(p.group) + one(p.world);
}

/** Секунды/миллисекунды/Date → миллисекунды epoch или null (SFTP отдаёт секунды). */
function toMillis(v) {
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

module.exports = { fileTypeChar, isDirMode, isLinkMode, permsFromMode, modeOctal, parseLongname, permsFromFtp, toMillis };
