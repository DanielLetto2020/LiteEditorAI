// Тесты очереди операций на соединение БД (lib/db.js: exclusive / откат транзакции).
// Запуск: node test/db-queue.test.js
'use strict';

const assert = require('assert');
const { _test } = require('../lib/db.js');
const { exclusive, runTransaction, readOnlyQuery, rawQuery, tableData, conns, sameDbEndpoint, sameSshEndpoint } = _test;

let passed = 0;
function ok(v, msg) { assert.ok(v, msg); passed++; }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; }
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// Фейковый pg-клиент: query(sql) ведёт журнал; failOn — sql, на которых бросает.
function fakePg(failOn = []) {
  const log = [];
  let ended = false;
  return {
    log, get ended() { return ended; },
    on() {},
    end() { ended = true; return Promise.resolve(); },
    async query(q) {
      const sql = typeof q === 'string' ? q : q.text;
      log.push(sql);
      await tick(1);
      if (failOn.includes(sql)) throw new Error('fail: ' + sql);
      return { rowCount: 1, rows: [], fields: [] };
    },
  };
}

(async () => {
  // 1. Строгая последовательность и счётчик занятости.
  {
    const h = {}; const order = [];
    const a = exclusive(h, async () => { order.push('a+'); ok(h.busy === 1, 'busy во время a'); await tick(10); order.push('a-'); return 1; });
    const b = exclusive(h, async () => { order.push('b+'); await tick(1); order.push('b-'); return 2; });
    ok(true, 'поставлены в очередь');
    eq(await Promise.all([a, b]), [1, 2], 'результаты по порядку');
    eq(order, ['a+', 'a-', 'b+', 'b-'], 'без перемешивания');
    eq(h.busy, 0, 'busy вернулся в 0');
  }
  // 2. Ошибка одной операции не рвёт цепочку.
  {
    const h = {};
    const a = exclusive(h, async () => { throw new Error('boom'); });
    const b = exclusive(h, async () => 'next');
    await assert.rejects(a, /boom/); passed++;
    eq(await b, 'next', 'следующая операция выполнилась');
    eq(h.busy, 0, 'busy после ошибки');
  }
  // 3. Транзакция pg: оператор упал, ROLLBACK прошёл — соединение остаётся в кэше.
  {
    const pg = fakePg(['UPDATE bad']);
    const h = { type: 'postgres', pg };
    conns.set('t3', h);
    await assert.rejects(exclusive(h, (x) => runTransaction(x, ['UPDATE bad'])), /fail: UPDATE bad/); passed++;
    eq(pg.log, ['BEGIN', 'UPDATE bad', 'ROLLBACK'], 'журнал pg');
    ok(conns.get('t3') === h && !pg.ended, 'соединение живо и в кэше');
    conns.delete('t3');
  }
  // 4. Транзакция pg: упал и ROLLBACK — исходная ошибка наружу, соединение выкинуто и закрыто.
  {
    const pg = fakePg(['UPDATE bad', 'ROLLBACK']);
    const h = { type: 'postgres', pg };
    conns.set('t4', h);
    await assert.rejects(exclusive(h, (x) => runTransaction(x, ['UPDATE bad'])), /fail: UPDATE bad/); passed++;
    ok(!conns.has('t4'), 'хэндл убран из кэша');
    ok(pg.ended, 'клиент закрыт');
    ok(h.broken === true, 'помечен сломанным');
  }
  // 5. readOnlyQuery pg с проваленным ROLLBACK — то же.
  {
    const pg = fakePg(['SELECT bad', 'ROLLBACK']);
    const h = { type: 'postgres', pg };
    conns.set('t5', h);
    await assert.rejects(exclusive(h, (x) => readOnlyQuery(x, 'SELECT bad')), /fail: SELECT bad/); passed++;
    ok(!conns.has('t5') && pg.ended, 'read-only: хэндл выкинут');
  }
  // 6. Успешная транзакция не трогает соединение.
  {
    const pg = fakePg();
    const h = { type: 'postgres', pg };
    conns.set('t6', h);
    eq(await exclusive(h, (x) => runTransaction(x, ['UPDATE ok'])), { ok: true, count: 1 }, 'успех');
    ok(conns.get('t6') === h && !pg.ended && !h.broken, 'соединение живо');
    conns.delete('t6');
  }
  // 7. MySQL multi-statement с первым не-SELECT оператором (fields[0] === undefined) не роняет rawQuery.
  {
    const h1 = {
      type: 'mysql',
      my: { async query() { return [[{ affectedRows: 0 }, [[42]]], [undefined, [{ name: '@a', type: 3 }]]]; } },
    };
    eq(await rawQuery(h1, 'SET @a = 1; SELECT @a;'), { columns: ['@a'], colTypes: ['number'], rows: [[42]], rowCount: 1 }, 'multi SET+SELECT');
    const h2 = {
      type: 'mysql',
      my: { async query() { return [[{ affectedRows: 1 }, { affectedRows: 2 }], [undefined, undefined]]; } },
    };
    eq(await rawQuery(h2, 'INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);'), { columns: [], rows: [], rowCount: 2 }, 'multi INSERT+INSERT');
  }
  // 8. tableData оборачивает WHERE в скобки + \n и нормализует limit/offset.
  {
    const seen = [];
    const h = {
      type: 'postgres',
      config: { readOnly: true },
      pg: {
        async query(q) {
          seen.push(typeof q === 'string' ? q : q.text);
          return { fields: [], rows: [[3]], rowCount: 1 };
        },
      },
    };
    const res = await tableData(h, 'public', 'items', { limit: 2.7, offset: Infinity, where: 'id > 0 -- comment' });
    eq(res.limit, 2, 'limit обрезан до int');
    eq(res.offset, 0, 'Infinity offset → 0');
    ok(seen[0].includes('WHERE (id > 0 -- comment\n) LIMIT 2 OFFSET 0'), 'комментарий -- не съедает LIMIT');
    await assert.rejects(tableData(h, 'public', 'items', { where: '1=1; DROP TABLE items' }), /одно условие/); passed++;
    await assert.rejects(tableData(h, 'public', 'items', { where: 'nextval(\'s\') > 0' }), /читающие/); passed++;
  }
  // 9. Политика сопоставления endpoint для секретов.
  {
    ok(sameDbEndpoint({ type: 'postgres', host: 'db.local', port: 5432, user: 'u' }, { type: 'postgres', host: 'DB.LOCAL', user: 'u' }), 'совпадает endpoint с дефолтным портом');
    ok(!sameDbEndpoint({ type: 'postgres', host: 'db.local', port: 5432, user: 'u' }, { type: 'postgres', host: 'evil.host', port: 5432, user: 'u' }), 'смена хоста сбрасывает совпадение');
    ok(!sameSshEndpoint({ sshHost: 'bastion', sshPort: 22, sshUser: 'root' }, { sshHost: 'bastion', sshPort: 2222, sshUser: 'root' }), 'смена SSH-порта сбрасывает совпадение');
  }
  console.log(`✓ db-queue: ${passed} проверок пройдено`);
})().catch((e) => { console.error(e); process.exit(1); });
