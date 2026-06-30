// safeChildName — валидация имени дочернего файла/папки перед path.join(parent, name).
//
// Защита от path traversal: имя, пришедшее из недоверенного источника (в т.ч. команда
// «Создать папку» с удалённого пульта → fs:mkdir/fs:create), не должно выходить за пределы
// родительского каталога. Без этого `name = "../../../../home/user/.ssh"` уводил бы создание
// наружу рабочего каталога. Возвращает очищенное имя (строка) либо null, если имя небезопасно.
//
// Чистая функция без зависимостей → тестируется обычным node (test/safe-name.test.js).
function safeChildName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  if (!n) return null;
  if (n === '.' || n === '..') return null;           // текущая/родительская папка
  if (n.includes('\0')) return null;                  // null-байт
  if (n.includes('/') || n.includes('\\')) return null; // любой сепаратор пути (POSIX/Windows)
  // Двоеточие: на Windows это диск ("C:"), диск-относительный путь и — главное — NTFS
  // alternate data stream ("file:stream", запись мимо видимого файла). На Windows ':' в имени
  // всё равно невалиден, поэтому режем его целиком (POSIX-имена с ':' редки и не нужны пульту).
  if (n.includes(':')) return null;
  return n;
}

module.exports = { safeChildName };
