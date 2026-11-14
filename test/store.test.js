// Тесты движка хранилища (lib/store.js): in-memory кэш, селективный снимок по modId,
// коалесируемая асинхронная запись, flushAllSync, карантин битого JSON и защита от затирания.
// Запуск: node test/store.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, atomicWriteSync, readJsonForEdit } = require('../lib/store');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; }

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-store-test-'));
  try {
    const store = createStore({ storeDir: dir, flushDelayMs: 40 });
    store.ensureDir();

    // 1. Чтение несуществующего ключа и мгновенная консистентность после записи
    eq(store.readStoreKey('projects'), undefined, 'несуществующий ключ даёт undefined');
    ok(store.writeStoreKey('projects', [{ id: 'p1', name: 'One', path: '/tmp/one' }], true), 'writeStoreKey успешен');
    eq(store.readStoreKey('projects'), [{ id: 'p1', name: 'One', path: '/tmp/one' }], 'чтение сразу видит новое значение из RAM до сброса на диск');

    // Мутация возвращённого объекта снаружи не портит внутренний кэш
    const leaked = store.readStoreKey('projects');
    leaked[0].name = 'MUTATED';
    eq(store.readStoreKey('projects')[0].name, 'One', 'кэш защищён от внешней мутации');

    // 2. Коалесирование частых записей в один сброс на диск
    for (let i = 1; i <= 25; i++) {
      store.writeStoreKey('layout', { leftWidth: 200 + i }, true);
    }
    eq(store.readStoreKey('layout'), { leftWidth: 225 }, 'последнее значение в памяти');
    await store.flushAllAsync();
    const diskLayout = JSON.parse(fs.readFileSync(store.storeFile('layout'), 'utf8'));
    eq(diskLayout, { leftWidth: 225 }, 'коалесированное значение записано на диск');

    // 3. patchStoreKey обновляет только указанные поля
    store.writeStoreKey('settings', { theme: 'graphite', fontSize: 13, oldFlag: true }, { sync: true });
    store.patchStoreKey('settings', { fontSize: 15 }, ['oldFlag']);
    eq(store.readStoreKey('settings'), { theme: 'graphite', fontSize: 15 }, 'patchStoreKey влил set и удалил unset');

    // 4. flushAllSync синхронно сбрасывает отложенную запись без ожидания таймера
    store.writeStoreKey('quickbar', ['files', 'gitgraph'], true);
    store.flushAllSync();
    eq(JSON.parse(fs.readFileSync(store.storeFile('quickbar'), 'utf8')), ['files', 'gitgraph'], 'flushAllSync сбросил отложенный ключ синхронно');

    // 5. Селективный снимок loadSnapshot({ modId }) не тащит чужие модульные ключи и MAIN_ONLY_KEYS
    store.writeStoreKey('dbConnections', [{ id: 'secret' }], { sync: true });
    store.writeStoreKey('seoSites', [{ url: 'https://example.com', snaps: ['huge'] }], { sync: true });
    store.writeStoreKey('pomodoro', { workMin: 25 }, { sync: true });
    store.writeStoreKey('bookmarks', { p1: [{ file: 'a.js', line: 1 }] }, { sync: true });

    const pomoSnap = store.loadSnapshot({ modId: 'pomodoro' });
    ok(pomoSnap.dbConnections === undefined, 'MAIN_ONLY_KEYS скрыты от окна модуля');
    ok(pomoSnap.seoSites === undefined, 'ключ чужого модуля seoSites не клонируется в окно pomodoro');
    ok(pomoSnap.bookmarks === undefined, 'bookmarks (files) не клонируется в окно pomodoro');
    ok(pomoSnap.noteCounts === undefined, 'noteCounts не считаются для окна модуля');
    eq(pomoSnap.pomodoro, { workMin: 25 }, 'свой ключ модуля присутствует');
    eq(pomoSnap.projects.length, 1, 'общий ключ projects присутствует в модуле');
    eq(pomoSnap.settings.fontSize, 15, 'общий ключ settings присутствует в модуле');

    const edSnap = store.loadSnapshot({ modId: '__editor__' });
    ok(edSnap.seoSites === undefined, 'главному окну не клонируется эксклюзивный ключ seoSites');
    eq(edSnap.quickbar, ['files', 'gitgraph'], 'главное окно получает свои ключи');
    ok(edSnap.noteCounts && typeof edSnap.noteCounts === 'object', 'главное окно получает noteCounts');

    const fullSnap = store.loadSnapshot();
    ok(fullSnap.seoSites !== undefined && fullSnap.pomodoro !== undefined, 'полный снимок без modId отдаёт все не-секретные ключи');
    ok(fullSnap.dbConnections === undefined, 'MAIN_ONLY_KEYS скрыты и в полном снимке');

    // 6. Кэш счётчиков задач и календаря + точечная инвалидация
    store.notesSet('p1', [{ id: '1', text: 'todo', status: 'todo' }, { id: '2', text: 'done', status: 'done' }]);
    eq(store.loadSnapshot({ modId: '__editor__' }).noteCounts, { p1: 1 }, 'активная задача учтена в кэше noteCounts');
    store.notesSet('p1', [{ id: '1', text: 'done', status: 'done' }]);
    eq(store.loadSnapshot({ modId: '__editor__' }).noteCounts, {}, 'выполненная задача обнулила счётчик без скана диска');

    const pastIso = new Date(Date.now() - 3600000).toISOString();
    store.agendaSet('p1', [{ id: 'a1', text: 'call', at: pastIso, done: false }]);
    eq(store.loadSnapshot({ modId: '__editor__' }).agendaCounts, { p1: 1 }, 'просроченное напоминание учтено в agendaCounts');

    // 7. Карантин повреждённого JSON (.corrupt-<ts>)
    fs.writeFileSync(store.storeFile('recents'), '{ broken json', 'utf8');
    const store2 = createStore({ storeDir: dir, flushDelayMs: 20 });
    eq(store2.readStoreKey('recents'), undefined, 'битый JSON вернул undefined');
    const files = fs.readdirSync(dir);
    ok(files.some((f) => f.startsWith('recents.json.corrupt-')), 'битый файл отложен в .corrupt-*');
    ok(!store2.hasReadFailed('recents'), 'после успешного карантина запись в ключ разрешена');

    // 8. atomicWriteSync сохраняет симлинк и права доступа
    const realTarget = path.join(dir, 'real-secret.json');
    const linkPath = path.join(dir, 'link-secret.json');
    fs.writeFileSync(realTarget, '{}', { mode: 0o600 });
    fs.chmodSync(realTarget, 0o600);
    fs.symlinkSync(realTarget, linkPath);
    atomicWriteSync(linkPath, '{"ok":true}');
    ok(fs.lstatSync(linkPath).isSymbolicLink(), 'симлинк не заменён обычным файлом');
    eq(fs.readFileSync(realTarget, 'utf8'), '{"ok":true}', 'запись прошла в целевой файл симлинка');
    eq(fs.statSync(realTarget).mode & 0o777, 0o600, 'права 0600 сохранены после атомарной записи');

    // 9. readJsonForEdit: ENOENT → fallback, битый JSON → карантин + fallback
    eq(readJsonForEdit(path.join(dir, 'no-such.json'), []), [], 'readJsonForEdit ENOENT → fallback');
    const badEdit = path.join(dir, 'bad-edit.json');
    fs.writeFileSync(badEdit, '[1, 2,', 'utf8');
    eq(readJsonForEdit(badEdit, ['clean']), ['clean'], 'readJsonForEdit отложил битый файл и вернул fallback');

    console.log(`✓ store: ${passed} проверок пройдено`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
