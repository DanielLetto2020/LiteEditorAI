// Тест парсера published-портов контейнера (кнопка «Открыть в браузере» модуля «Контейнеры»).
// Запуск: node test/portparse.test.js
const assert = require('assert');
const { parsePublishedPorts, portUrl, portLabel } = require('../lib/portparse.js');

// docker: IPv4+IPv6-дубли одного маппинга схлопываются в одну запись (wildcard → hostIp:null)
let r = parsePublishedPorts('0.0.0.0:8080->80/tcp, :::8080->80/tcp');
assert.strictEqual(r.length, 1);
assert.deepStrictEqual(r[0], { hostIp: null, hostPort: 8080, containerPort: 80 });

// docker: unpublished (без «->») не попадает
assert.deepStrictEqual(parsePublishedPorts('6379/tcp'), []);

// docker: udp — пропуск; диапазоны — пропуск без падения
assert.deepStrictEqual(parsePublishedPorts('0.0.0.0:53->53/udp'), []);
assert.deepStrictEqual(parsePublishedPorts('0.0.0.0:32768-32770->80-82/tcp'), []);

// docker: конкретный bind-IP сохраняется (и выигрывает у wildcard-дубля)
r = parsePublishedPorts('127.0.0.1:5432->5432/tcp');
assert.strictEqual(r[0].hostIp, '127.0.0.1');
r = parsePublishedPorts(':::9000->9000/tcp, 192.168.1.5:9000->9000/tcp');
assert.strictEqual(r.length, 1);
assert.strictEqual(r[0].hostIp, '192.168.1.5');

// docker: IPv6-литерал в скобках → чистый IP, а portUrl вернёт его обратно в скобках
r = parsePublishedPorts('[::1]:8443->8443/tcp');
assert.strictEqual(r[0].hostIp, '::1');
assert.strictEqual(portUrl(r[0]), 'https://[::1]:8443');

// podman-сборка main.js: «host:container», без bind-IP; элемент без двоеточия = unpublished
r = parsePublishedPorts('8080:80, 9000:9000');
assert.strictEqual(r.length, 2);
assert.ok(r.every((p) => p.hostIp === null));
assert.deepStrictEqual(parsePublishedPorts('80'), []);

// сортировка: контейнерные веб-порты вперёд (80 раньше 5432, хоть hostPort и больше)
r = parsePublishedPorts('5432:5432, 18081:80');
assert.strictEqual(r[0].containerPort, 80);
assert.strictEqual(r[1].containerPort, 5432);

// схема: 443/8443 → https, остальное http; туннельный override хоста и порта
const p80 = { hostIp: null, hostPort: 18081, containerPort: 80 };
assert.strictEqual(portUrl(p80), 'http://127.0.0.1:18081');
assert.strictEqual(portUrl({ hostIp: null, hostPort: 18443, containerPort: 443 }), 'https://127.0.0.1:18443');
assert.strictEqual(portUrl(p80, '127.0.0.1', 41230), 'http://127.0.0.1:41230');

// подписи: маппинг и совпадающие порты, хинт по контейнерному порту
assert.strictEqual(portLabel({ hostIp: null, hostPort: 18081, containerPort: 80 }), '18081 → 80 · http');
assert.strictEqual(portLabel({ hostIp: null, hostPort: 5432, containerPort: 5432 }), ':5432 · PostgreSQL');
assert.strictEqual(portLabel({ hostIp: null, hostPort: 7777, containerPort: 7777 }), ':7777');

// мусор и пустота — не падаем
assert.deepStrictEqual(parsePublishedPorts(''), []);
assert.deepStrictEqual(parsePublishedPorts(null), []);
assert.deepStrictEqual(parsePublishedPorts('garbage, ->, :'), []);

console.log('portparse.test.js: OK');
