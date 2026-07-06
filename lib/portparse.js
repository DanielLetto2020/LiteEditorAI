// Разбор строки портов контейнера в список published-портов (для кнопки «Открыть в браузере»
// модуля «Контейнеры»). Два формата на входе: сырая строка `docker ps` («0.0.0.0:8080->80/tcp»)
// и сборка из podman ps --format json в main.js («8080:80, 9000:9000»). Чистый CJS без
// зависимостей: renderer подключает через esbuild (прецедент — lib/sgrline.js), тест — node.

// Контейнерные веб-порты — в выпадашке идут первыми (зеркало WEB_PORTS в lib/dbdetect.js + 8443).
const WEB_PORTS = [80, 443, 8080, 8443, 3000, 8000, 5173, 4200, 8081, 8888, 5601, 9000];

// Подписи известных портов для строк выпадашки/тултипа. Ключ — контейнерный порт.
const PORT_HINTS = {
  80: 'http', 443: 'https', 8080: 'http', 8443: 'https', 3000: 'web/dev', 8000: 'web/dev',
  5173: 'vite', 4200: 'angular', 8081: 'http', 8888: 'jupyter', 5601: 'kibana', 9000: 'web',
  15672: 'RabbitMQ UI', 9092: 'Kafka', 5432: 'PostgreSQL', 3306: 'MySQL', 6379: 'Redis',
  27017: 'MongoDB', 5672: 'AMQP', 9200: 'Elasticsearch',
};

// → [{ hostIp: string|null, hostPort, containerPort }], только published/tcp, веб-порты первыми.
// hostIp = null для wildcard-бинда (0.0.0.0 / :: / *) — открывать через 127.0.0.1.
// Дубли одного маппинга (IPv4+IPv6 у docker) схлопываются; конкретный IP приоритетнее wildcard.
function parsePublishedPorts(portsStr) {
  const out = new Map(); // 'hostPort:containerPort' -> запись
  for (const raw of String(portsStr || '').split(',')) {
    const item = raw.trim();
    if (!item) continue;
    let hostIp = null, hostPort, containerPort;
    const arrow = item.indexOf('->');
    if (arrow > 0) { // docker: «0.0.0.0:8080->80/tcp» | «:::8080->80/tcp» | «[::1]:443->443/tcp»
      const left = item.slice(0, arrow);
      const rm = item.slice(arrow + 2).match(/^(\d+)(?:\/(\w+))?$/);
      if (!rm) continue;                      // диапазон «80-82/tcp» или мусор — пропуск
      if (rm[2] && rm[2] !== 'tcp') continue; // udp/sctp в браузере не открыть
      containerPort = parseInt(rm[1], 10);
      const ci = left.lastIndexOf(':');
      const portStr = ci >= 0 ? left.slice(ci + 1) : left;
      if (!/^\d+$/.test(portStr)) continue;   // «32768-32770» и прочие не-порты
      hostPort = parseInt(portStr, 10);
      const ip = ci > 0 ? left.slice(0, ci).replace(/^\[|\]$/g, '') : '';
      hostIp = (!ip || ip === '0.0.0.0' || ip === '::' || ip === '*') ? null : ip;
    } else { // podman-сборка: «8080:80»; элемент без двоеточия = unpublished
      const m = item.match(/^(\d+):(\d+)$/);
      if (!m) continue;
      hostPort = parseInt(m[1], 10); containerPort = parseInt(m[2], 10);
    }
    if (!(hostPort > 0 && hostPort < 65536) || !(containerPort > 0 && containerPort < 65536)) continue;
    const key = hostPort + ':' + containerPort;
    const prev = out.get(key);
    if (!prev || (!prev.hostIp && hostIp)) out.set(key, { hostIp, hostPort, containerPort });
  }
  const rank = (p) => { const i = WEB_PORTS.indexOf(p.containerPort); return i < 0 ? WEB_PORTS.length : i; };
  return [...out.values()].sort((a, b) => (rank(a) - rank(b)) || (a.hostPort - b.hostPort));
}

// URL для порта: https у 443/8443, хост — bind-IP контейнера либо 127.0.0.1.
// host/portOverride — для туннельного режима (локальный конец туннеля).
function portUrl(p, host, portOverride) {
  const scheme = (p.containerPort === 443 || p.containerPort === 8443) ? 'https' : 'http';
  let h = host || p.hostIp || '127.0.0.1';
  if (h.includes(':')) h = '[' + h + ']'; // IPv6-литерал
  return scheme + '://' + h + ':' + (portOverride || p.hostPort);
}

// Подпись строки выпадашки: «8080 → 80 · http» / «:5432 · PostgreSQL».
function portLabel(p) {
  const hint = PORT_HINTS[p.containerPort] || '';
  const base = p.hostPort === p.containerPort ? ':' + p.hostPort : p.hostPort + ' → ' + p.containerPort;
  return hint ? base + ' · ' + hint : base;
}

module.exports = { parsePublishedPorts, portUrl, portLabel, PORT_HINTS, WEB_PORTS };
