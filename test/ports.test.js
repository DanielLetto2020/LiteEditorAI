// Тесты определения слушающих портов терминала (lib/ports.js).
// Запуск: node test/ports.test.js
'use strict';

const assert = require('assert');
const net = require('net');
const { parseProcNetTcp, isLoopbackHex, socketInodes, listeningPorts } = require('../lib/ports.js');

let passed = 0;
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; }
function ok(v, msg) { assert.ok(v, msg); passed++; }

const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111111 1 0000000000000000 100 0 0 10 0
   1: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222222 1 0000000000000000 100 0 0 10 0
   2: 0100007F:A2C4 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 333333 1 0000000000000000 20 4 30 10 -1
   3: 0100007F:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 0 1 0000000000000000 100 0 0 10 0
`;
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:14E9 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444444 1 0000000000000000 100 0 0 10 0
`;

eq(parseProcNetTcp(TCP), [
  { port: 8080, inode: '111111', addr: '0100007F' },
  { port: 5173, inode: '222222', addr: '00000000' },
], 'tcp: только LISTEN, без inode 0');
eq(parseProcNetTcp(TCP6), [{ port: 5353, inode: '444444', addr: '00000000000000000000000001000000' }], 'tcp6');
eq(parseProcNetTcp(''), [], 'пусто');
eq(parseProcNetTcp('header\nмусор\n'), [], 'мусор');

ok(isLoopbackHex('0100007F'), '127.0.0.1');
ok(!isLoopbackHex('00000000'), '0.0.0.0');
ok(isLoopbackHex('00000000000000000000000001000000'), '::1');
ok(!isLoopbackHex('00000000000000000000000000000000'), '::');
ok(isLoopbackHex('0000000000000000FFFF00000100007F'), '::ffff:127.0.0.1');

eq([...socketInodes(['socket:[12]', 'pipe:[13]', '/dev/pts/1', 'socket:[14]', 'socket:[12]'])], ['12', '14'], 'inode сокетов');

eq(listeningPorts(process.pid, { platform: 'darwin' }), [], 'не Linux — пусто');

(async () => {
  if (process.platform === 'linux') {
    // Живая проверка: этот процесс слушает порт — он должен найтись у собственного pid.
    const srv = net.createServer();
    await new Promise((r) => srv.listen({ port: 0, host: '127.0.0.1' }, () => r(null)));
    const port = /** @type {import('net').AddressInfo} */ (srv.address()).port;
    const found = listeningPorts(process.pid).find((x) => x.port === port);
    ok(found, 'свой слушающий порт найден');
    ok(found && found.pid === process.pid && found.loopback === true, 'pid и loopback');
    eq(listeningPorts(process.pid, { excludePids: [process.pid] }).filter((x) => x.port === port), [], 'сокет исключённого процесса не считается');
    await new Promise((r) => srv.close(() => r(null)));
    ok(!listeningPorts(process.pid).some((x) => x.port === port), 'после close порт пропал');
  }
  console.log(`✓ ports: ${passed} проверок пройдено`);
})().catch((e) => { console.error(e); process.exit(1); });
