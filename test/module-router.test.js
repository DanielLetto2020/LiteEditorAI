// Юнит-тесты lib/module-router.js: очередь готовности окон/доков, доставка module:arg и ленивый IPC.
'use strict';

const assert = require('assert');
const { createModuleRouter, createLazyIpc } = require('../lib/module-router');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; }

(async () => {
  // 1. Очередь до готовности окна и выгрузка строго по порядку при markReady
  {
    const log = [];
    let win = null;
    const router = createModuleRouter({
      ensureTarget: (id) => { log.push(['ensure', id]); if (!win) win = { id, alive: true }; },
      getTarget: () => (win && win.alive ? win : null),
      sendToTarget: (t, ch, p) => { if (!t || !t.alive) return false; log.push(['send', t.id, ch, p]); return true; },
      focusTarget: (t) => { log.push(['focus', t.id]); },
    });

    eq(router.isReady('db'), false, 'изначально не готов');
    eq(router.sendWhenReady('db', 'db:openFromContainer', { port: 5432 }, { focus: true }), false, 'в очередь до готовности');
    eq(router.sendWhenReady('db', 'db:openSql', { sql: 'SELECT 1' }, { focus: true }), false, 'второе сообщение в очередь');
    eq(router.pendingCount('db'), 2, '2 сообщения ждут в очереди');

    const sent = router.markReady('db');
    eq(sent, 2, 'выгружены оба сообщения');
    eq(router.isReady('db'), true, 'модуль помечен готовым');
    eq(router.pendingCount('db'), 0, 'очередь пуста');

    // Когда уже готов — отправка идёт синхронно без накопления в очередь
    eq(router.sendWhenReady('db', 'db:openSql', { sql: 'SELECT 2' }, { focus: false }), true, 'мгновенная доставка готовому окну');
    eq(log, [
      ['ensure', 'db'],
      ['ensure', 'db'],
      ['focus', 'db'],
      ['send', 'db', 'db:openFromContainer', { port: 5432 }],
      ['focus', 'db'],
      ['send', 'db', 'db:openSql', { sql: 'SELECT 1' }],
      ['ensure', 'db'],
      ['send', 'db', 'db:openSql', { sql: 'SELECT 2' }],
    ], 'порядок вызовов ensure/focus/send совпадает');

    // Закрытие окна сбрасывает готовность; повторное открытие снова ждёт markReady
    win = null;
    router.markNotReady('db');
    eq(router.isReady('db'), false, 'после закрытия не готов');
    eq(router.sendWhenReady('db', 'db:openFromContainer', { port: 3306 }), false, 'снова копит до нового markReady');
    eq(router.pendingCount('db'), 1, 'одно сообщение в новой очереди');
  }

  // 2. dedupe и ограничение maxQueue (напр. editor:focusGit и voice:open с капом 10)
  {
    const delivered = [];
    const target = { name: 'dock-frame' };
    const router = createModuleRouter({
      getTarget: () => target,
      sendToTarget: (_t, ch, p) => { delivered.push([ch, p]); return true; },
    });

    router.sendWhenReady('files', 'editor:focusGit', undefined, { dedupe: true });
    router.sendWhenReady('files', 'editor:focusGit', undefined, { dedupe: true });
    eq(router.pendingCount('files'), 1, 'dedupe схлопывает повторный сигнал до готовности');

    for (let i = 1; i <= 5; i++) {
      router.sendWhenReady('voice', 'voice:open', { n: i }, { maxQueue: 3 });
    }
    eq(router.pendingCount('voice'), 3, 'maxQueue удерживает хвост из 3 последних элементов');
    router.markReady('voice');
    eq(delivered, [
      ['voice:open', { n: 3 }],
      ['voice:open', { n: 4 }],
      ['voice:open', { n: 5 }],
    ], 'доставлены именно последние 3 элемента очереди');

    router.markReady('files');
    eq(delivered.length, 4, 'editor:focusGit доставлен один раз');
    eq(delivered[3][0], 'editor:focusGit', 'канал editor:focusGit');
  }

  // 3. Потеря живого таргета без явного markNotReady автоматически возвращает сообщение в очередь
  {
    let alive = true;
    const router = createModuleRouter({
      getTarget: () => (alive ? { ok: true } : null),
      sendToTarget: () => alive,
    });
    router.markReady('rmq');
    eq(router.sendWhenReady('rmq', 'rmq:openFromContainer', { a: 1 }), true, 'живому ушло сразу');
    alive = false;
    eq(router.sendWhenReady('rmq', 'rmq:openFromContainer', { a: 2 }), false, 'умершему встало в очередь');
    eq(router.isReady('rmq'), false, 'готовность сброшена при мёртвом таргете');
    eq(router.pendingCount('rmq'), 1, 'сообщение не потеряно');
  }

  // 4. deliverArg и consumeArg (последний аргумент заменяет предыдущий, закрытие окна чистит невыданный)
  {
    const sent = [];
    const router = createModuleRouter({
      getTarget: () => null,
      sendToTarget: (t, ch, p) => { sent.push([t, ch, p]); return true; },
    });
    router.deliverArg('servers', { view: 'overview' }, null);
    router.deliverArg('servers', { view: 'sites' }, null);
    eq(router.consumeArg('servers', 'win1'), true, 'выдан отложенный аргумент');
    eq(sent, [['win1', 'module:arg', { view: 'sites' }]], 'доставлен последний аргумент');
    eq(router.consumeArg('servers', 'win1'), false, 'повторно тот же аргумент не выдаётся');

    router.deliverArg('rh', { connId: 'c1' }, 'readyWin');
    eq(sent.length, 2, 'готовому окну module:arg ушёл сразу');
    eq(sent[1], ['readyWin', 'module:arg', { connId: 'c1' }], 'прямая доставка готовому окну');

    router.deliverArg('rh', { connId: 'c2' }, null);
    router.markNotReady('rh'); // окно закрыли, не дождавшись module:ready
    eq(router.consumeArg('rh', 'win2'), false, 'после закрытия старый аргумент не протекает в новое окно');
  }

  // 5. createLazyIpc: load вызывается лениво и ровно один раз при первом вызове канала
  {
    const regHandles = new Map();
    const regOns = new Map();
    const fakeIpc = {
      handle: (ch, fn) => regHandles.set(ch, fn),
      on: (ch, fn) => regOns.set(ch, fn),
    };
    let loadCalls = 0;
    let closedCount = 0;

    const lazy = createLazyIpc(fakeIpc, {
      handles: ['demo:list', 'demo:ping'],
      ons: ['demo:stop'],
      load(ipc) {
        loadCalls++;
        ipc.handle('demo:list', () => ({ items: [1, 2, 3] }));
        ipc.handle('demo:ping', async (_e, x) => ({ pong: x }));
        ipc.on('demo:stop', () => { closedCount++; });
        return { closeAll: () => { closedCount += 10; } };
      },
    });

    eq(lazy.isLoaded(), false, 'до вызовов бэкенд не загружен');
    eq(lazy.getApi(), null, 'getApi() до загрузки возвращает null (не провоцируя require)');
    eq(loadCalls, 0, 'load не вызывался на старте');
    ok(regHandles.has('demo:list') && regHandles.has('demo:ping'), 'прокси-каналы handle зарегистрированы');
    ok(regOns.has('demo:stop'), 'прокси-канал on зарегистрирован');

    const r1 = regHandles.get('demo:list')({}, {});
    eq(r1, { items: [1, 2, 3] }, 'первый вызов подгрузил бэкенд и вернул ответ');
    eq(lazy.isLoaded(), true, 'теперь загружен');
    eq(loadCalls, 1, 'load вызван ровно 1 раз');

    const r2 = await regHandles.get('demo:ping')({}, 42);
    eq(r2, { pong: 42 }, 'асинхронный канал тоже работает');
    regOns.get('demo:stop')({});
    eq(closedCount, 1, 'on-канал проксируется без повторного load');
    eq(loadCalls, 1, 'повторных вызовов load нет');

    lazy.getApi().closeAll();
    eq(closedCount, 11, 'API загруженного бэкенда доступен для штатного closeAll()');
  }

  console.log(`✓ module-router: ${passed} проверок пройдено`);
})();
