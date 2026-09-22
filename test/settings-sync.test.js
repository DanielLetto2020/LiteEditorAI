// Тест синхронизации settings между окнами (renderer/settings-sync.js). Раньше каждое окно писало
// свою копию целиком, и последняя запись затирала чужие правки: язык → тема → перезапуск давало
// снова русский, вид канбан «Задач» сбрасывался от Ctrl+= в редакторе.
// Здесь два «окна» и маленький main с той же логикой, что patchStoreKey в main.js.
// Запуск: node test/settings-sync.test.js
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

(async () => {
  const { syncSettings } = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'settings-sync.js')).href);

  // «Диск» и main: вливает патч и рассылает его всем окнам, кроме отправителя.
  let disk = { theme: 'neumorphism', fontSize: 13 };
  const windows = [];
  function patch(from, key, set, unset) {
    for (const k of Object.keys(set)) disk[k] = JSON.parse(JSON.stringify(set[k]));
    for (const k of unset) delete disk[k];
    for (const w of windows) if (w !== from) for (const cb of w.listeners) cb({ key, set, unset });
  }
  function makeWindow() {
    const w = { listeners: [] };
    w.lite = { store: { patch: (key, set, unset) => patch(w, key, set, unset), onChanged: (cb) => w.listeners.push(cb) } };
    windows.push(w);
    return w;
  }

  // Редактор: дефолты поверх диска (как loadSettings), base — то, что на диске.
  const ed = makeWindow();
  const edSettings = { notifications: true, fontSize: 13, theme: 'neumorphism', ...JSON.parse(JSON.stringify(disk)) };
  const edSync = syncSettings(ed.lite, edSettings, { base: JSON.parse(JSON.stringify(disk)) });

  // Окно «Задач»: своя копия диска.
  const notes = makeWindow();
  let remoteSeen = 0;
  const notesSettings = JSON.parse(JSON.stringify(disk));
  const notesSync = syncSettings(notes.lite, notesSettings, { base: JSON.parse(JSON.stringify(disk)), onRemote: () => { remoteSeen++; } });

  // --- первый save редактора пишет и дефолты (как раньше, когда объект уходил целиком) ---
  edSettings.fontSize = 14;
  edSync.save();
  ok(disk.fontSize === 14 && disk.notifications === true, 'первый save редактора записал изменение и дефолты');
  ok(notesSettings.fontSize === 14, 'окно «Задач» получило новый размер шрифта');
  ok(remoteSeen === 1, 'onRemote вызван один раз');

  // --- окно «Задач» меняет вид — редактор узнаёт, его следующий save вид не затирает ---
  notesSettings.notesView = 'kanban';
  notesSync.save();
  ok(disk.notesView === 'kanban', 'вид задач записан');
  ok(edSettings.notesView === 'kanban', 'редактор получил вид задач');
  edSettings.fontSize = 15;           // Ctrl+= в редакторе
  edSync.save();
  ok(disk.notesView === 'kanban' && disk.fontSize === 15, 'Ctrl+= не сбросил вид задач');

  // --- смена языка из main (i18n:set) → затем смена темы в редакторе ---
  patch(null, 'settings', { lang: 'en' }, []);
  edSettings.theme = 'glass';
  edSync.save();
  ok(disk.lang === 'en' && disk.theme === 'glass', 'язык пережил смену темы: ' + JSON.stringify(disk));

  // --- удаление поля доходит до диска и до других окон ---
  delete notesSettings.notesView;
  notesSync.save();
  ok(!('notesView' in disk) && !('notesView' in edSettings), 'удалённое поле убрано с диска и из редактора');

  // --- save без изменений не шлёт ничего ---
  let sent = 0;
  const orig = ed.lite.store.patch;
  ed.lite.store.patch = (...a) => { sent++; return orig(...a); };
  ok(edSync.save() === false && sent === 0, 'пустой save ничего не отправил');

  console.log(`settings-sync: ${passed} проверок пройдено`);
})().catch((e) => { console.error(e); process.exit(1); });
