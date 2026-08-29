// safeChildName — валидация имени дочернего файла/папки перед path.join(parent, name).
//
// Защита от path traversal: имя, пришедшее из недоверенного источника (в т.ч. команда
// имя папки из fs:mkdir/fs:create, ключ объекта из чужого бакета), не должно выходить за пределы
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
  // всё равно невалиден, поэтому режем его целиком (POSIX-имена с ':' редки и не нужны).
  if (n.includes(':')) return null;
  return n;
}

// safeRelSegments — путь ОТНОСИТЕЛЬНО каталога, собранный из недоверенного источника.
//
// Ключ объекта в бакете (модуль «Внешние хранилища») — произвольная строка, а не путь, которому
// можно верить: сегмент '..' уводил бы path.join выше выбранной папки при «Скачать папку», и
// загрузка из чужого бакета молча перезаписывала бы файлы человека. Каждый сегмент чистим до имени
// файла: сепараторы и спецсимволы → '_', '.'/'..' выкидываем.
const SEG_BAD = /[\\/:*?"<>|\0]/g;
function safeRelSegments(rel) {
  const parts = String(rel).split('/')
    .map((s) => s.replace(SEG_BAD, '_').trim())
    .filter((s) => s && s !== '.' && s !== '..');
  return parts.length ? parts : ['object'];   // ключ выродился в пустой путь — не пишем в саму папку
}

module.exports = { safeChildName, safeRelSegments };
