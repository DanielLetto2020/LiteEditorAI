// Бэкенд модуля «RabbitMQ»: профили серверов + management HTTP API (обычно порт 15672).
// Без зависимостей — HTTP через глобальный fetch (Node 18+); секреты шифрует safeStorage
// (схема enc/dec — как в lib/db.js). Соединение stateless: живых хэндлов нет, каждый вызов —
// один HTTP-запрос с basic auth. AMQP-порт хранится в профиле про запас (live-tail, v2).
//
// main.js: registerRmqIpc({ ipcMain, safeStorage, getConnections, setConnections }).

let _safe = null, _get = null, _set = null;

// ---------------------------------------------------------------- secrets (как lib/db.js)
function enc(text) {
  if (!text) return '';
  try { if (_safe && _safe.isEncryptionAvailable()) return 'v1:' + _safe.encryptString(text).toString('base64'); } catch (_) {}
  return 'b64:' + Buffer.from(String(text), 'utf8').toString('base64'); // fallback: только обфускация
}
function dec(blob) {
  if (!blob) return '';
  try {
    if (blob.startsWith('v1:')) return _safe.decryptString(Buffer.from(blob.slice(3), 'base64'));
    if (blob.startsWith('b64:')) return Buffer.from(blob.slice(4), 'base64').toString('utf8');
  } catch (_) {}
  return '';
}

// ---------------------------------------------------------------- store
function loadConns() { const a = _get(); return Array.isArray(a) ? a : []; }
function saveConns(a) { _set(a); }
function publicConn(c) { const { passEnc, ...rest } = c; return { ...rest, hasPass: !!passEnc }; }
function publicList() { return loadConns().map(publicConn); }
function connById(id) {
  const c = loadConns().find((x) => x.id === id);
  if (!c) throw new Error('Профиль не найден');
  return c;
}

// ---------------------------------------------------------------- management HTTP API
// c: { host, port, tls, user, passEnc } (полная запись из стора или merged-конфиг теста).
// path — уже с закодированным vhost (encodeURIComponent, '/' → %2F).
async function api(c, method, path, body) {
  const base = (c.tls ? 'https' : 'http') + '://' + (c.host || '127.0.0.1') + ':' + (+c.port || 15672);
  const auth = Buffer.from((c.user || 'guest') + ':' + dec(c.passEnc)).toString('base64');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  let res;
  try {
    res = await fetch(base + path, {
      method: method || 'GET', signal: ctl.signal,
      headers: { Authorization: 'Basic ' + auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? 'Таймаут запроса (15с) — сервер не отвечает' : 'Нет соединения с ' + base + ' (' + String(e.message || e) + ')');
  } finally { clearTimeout(t); }
  if (res.status === 401) throw new Error('Доступ запрещён (401) — проверь логин/пароль');
  if (res.status === 403) throw new Error('Недостаточно прав (403) — юзеру нужен доступ к management');
  const text = await res.text();
  if (!res.ok) {
    let reason = '';
    try { reason = JSON.parse(text).reason || ''; } catch (_) {}
    throw new Error(`HTTP ${res.status}${reason ? ': ' + reason : ''}${!reason && text ? ': ' + text.slice(0, 200) : ''}`);
  }
  return text ? JSON.parse(text) : null;
}
const vh = (vhost) => encodeURIComponent(vhost || '/');

// Слим-маппинг тяжёлых ответов API: в рендерер уходит только нужное (список очередей у
// брокера с сотнями очередей — мегабайты сырого JSON, режем на бэке).
const rate = (d) => (d && typeof d.rate === 'number') ? d.rate : null;
// Исторические сэмплы management API (те же, что рисует стандартный UI): gauge — как есть,
// счётчики (publish/deliver/…) кумулятивны → дифференцируем в сообщ./с; рестарт (спад) → 0.
function gaugeSeries(d) {
  const s = (d && Array.isArray(d.samples)) ? d.samples : [];
  return s.map((x) => ({ t: x.timestamp, v: x.sample })).sort((a, b) => a.t - b.t);
}
function rateSeries(d) {
  const s = gaugeSeries(d);
  const out = [];
  for (let i = 1; i < s.length; i++) {
    const dt = (s[i].t - s[i - 1].t) / 1000;
    out.push({ t: s[i].t, v: dt > 0 ? Math.max(0, (s[i].v - s[i - 1].v) / dt) : 0 });
  }
  return out;
}
function slimQueue(q) {
  const st = q.message_stats || {};
  const args = q.arguments || {};
  return {
    name: q.name, vhost: q.vhost, state: q.state || '',
    messages: q.messages || 0, ready: q.messages_ready || 0, unacked: q.messages_unacknowledged || 0,
    consumers: q.consumers || 0, durable: !!q.durable, exclusive: !!q.exclusive, autoDelete: !!q.auto_delete,
    inRate: rate(st.publish_details), outRate: rate(st.deliver_get_details),
    memory: q.memory || 0, idleSince: q.idle_since || '',
    dlx: args['x-dead-letter-exchange'] || '', ttl: args['x-message-ttl'] != null ? args['x-message-ttl'] : null,
    qtype: (args['x-queue-type'] || q.type || 'classic'),
    spark: (q.messages_details && Array.isArray(q.messages_details.samples)) ? gaugeSeries(q.messages_details) : null,
  };
}
function slimExchange(e) {
  return { name: e.name, vhost: e.vhost, type: e.type, durable: !!e.durable, internal: !!e.internal, autoDelete: !!e.auto_delete,
    inRate: rate(e.message_stats && e.message_stats.publish_in_details), outRate: rate(e.message_stats && e.message_stats.publish_out_details) };
}
function slimConnection(cn) {
  const cp = cn.client_properties || {};
  return {
    name: cn.name, user: cn.user, vhost: cn.vhost, state: cn.state || '',
    peer: (cn.peer_host || '') + (cn.peer_port ? ':' + cn.peer_port : ''),
    channels: cn.channels || 0, protocol: cn.protocol || '',
    client: [cp.product, cp.version].filter(Boolean).join(' '),
    recvRate: rate(cn.recv_oct_details), sendRate: rate(cn.send_oct_details),
    connectedAt: cn.connected_at || null,
  };
}

// ---------------------------------------------------------------- live-tail (amqplib)
// Наблюдение за потоком exchange БЕЗ кражи сообщений у реальных консюмеров: временная
// exclusive/auto-delete очередь биндится на exchange и получает СВОИ копии. AMQP-соединение —
// одно на стрим, закрывается со стопом/закрытием окна. Этого в стандартном management UI нет.
let amqplib = null;          // ленивый require — не грузим, пока tail не понадобился
const tails = new Map();     // streamId -> { close }

async function openTail(c, { vhost, exchange, routingKey }, onMsg, onClose) {
  if (!exchange) throw new Error('Нужен именованный exchange — default биндинг не поддерживает');
  if (!amqplib) amqplib = require('amqplib');
  const url = 'amqp://' + encodeURIComponent(c.user || 'guest') + ':' + encodeURIComponent(dec(c.passEnc)) +
    '@' + (c.host || '127.0.0.1') + ':' + (+c.amqpPort || 5672) + '/' + encodeURIComponent(vhost || '/');
  const conn = await amqplib.connect(url);
  conn.on('error', () => {}); // обрыв без слушателя = uncaught exception в main
  let ch;
  try {
    ch = await conn.createChannel();
    ch.on('error', () => {});
    const q = await ch.assertQueue('', { exclusive: true, autoDelete: true, arguments: { 'x-max-length': 10000 } });
    await ch.bindQueue(q.queue, exchange, routingKey == null ? '#' : String(routingKey));
    await ch.consume(q.queue, (msg) => {
      if (!msg) return;
      let payload = msg.content.toString('utf8');
      if (payload.length > 20000) payload = payload.slice(0, 20000) + '\n… [обрезано]';
      onMsg({
        exchange: msg.fields.exchange, routingKey: msg.fields.routingKey, redelivered: !!msg.fields.redelivered,
        size: msg.content.length, ts: Date.now(), payload,
        properties: { contentType: msg.properties.contentType || '', deliveryMode: msg.properties.deliveryMode || null, headers: msg.properties.headers || {} },
      });
    }, { noAck: true });
  } catch (e) { try { conn.close(); } catch (_) {} throw e; }
  conn.on('close', () => { if (onClose) onClose(); });
  return { close: () => { try { ch.close(); } catch (_) {} try { conn.close(); } catch (_) {} } };
}

// ---------------------------------------------------------------- IPC
function registerRmqIpc({ ipcMain, safeStorage, getConnections, setConnections }) {
  _safe = safeStorage; _get = getConnections; _set = setConnections;

  ipcMain.handle('rmq:list', () => ({ connections: publicList(), secure: !!(safeStorage && safeStorage.isEncryptionAvailable()) }));

  // Создание/правка профиля. Пароль приходит только когда меняется; нет — оставляем блоб.
  ipcMain.handle('rmq:save', (_e, { conn } = {}) => {
    if (!conn || !conn.name) return { error: 'нет данных профиля' };
    const list = loadConns();
    const idx = conn.id ? list.findIndex((x) => x.id === conn.id) : -1;
    const prev = idx >= 0 ? list[idx] : {};
    const rec = { ...prev, ...conn };
    delete rec.hasPass;
    if (conn.password != null) rec.passEnc = conn.password ? enc(conn.password) : '';
    delete rec.password;
    if (!rec.id) rec.id = 'mq' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
    if (idx >= 0) list[idx] = rec; else list.push(rec);
    saveConns(list);
    return { ok: true, id: rec.id, connection: publicConn(rec) };
  });
  ipcMain.handle('rmq:delete', (_e, { id } = {}) => { saveConns(loadConns().filter((x) => x.id !== id)); return { ok: true }; });

  // Тест: поля формы поверх сохранённых; пароль — введённый, иначе сохранённый блоб.
  ipcMain.handle('rmq:test', async (_e, { conn } = {}) => {
    const saved = conn && conn.id ? (loadConns().find((x) => x.id === conn.id) || {}) : {};
    const cfg = { ...saved, ...conn };
    cfg.passEnc = conn && conn.password != null ? (conn.password ? enc(conn.password) : '') : (saved.passEnc || '');
    try {
      const who = await api(cfg, 'GET', '/api/whoami');
      const ov = await api(cfg, 'GET', '/api/overview');
      return { ok: true, version: 'RabbitMQ ' + (ov.rabbitmq_version || ov.product_version || '?'), user: who && who.name, tags: (who && who.tags) || [] };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  const dataCall = (fn) => async (_e, args = {}) => {
    try { return await fn(connById(args.id), args); }
    catch (e) { return { error: String(e.message || e) }; }
  };
  const actionCall = (fn) => async (_e, args = {}) => {
    try { const r = await fn(connById(args.id), args); return { ok: true, ...(r || {}) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  };

  // Обзор: тоталы/рейты + ноды (alarms по памяти/диску) + исторические серии для графиков
  // (lengths_age/msg_rates_age — ровно те параметры, которыми пользуется стандартный UI).
  ipcMain.handle('rmq:overview', dataCall(async (c, { age } = {}) => {
    const a = Math.max(60, Math.min(86400, +age || 600));
    const inc = Math.max(5, Math.round(a / 120)); // ~120 точек на график
    const qs = `?lengths_age=${a}&lengths_incr=${inc}&msg_rates_age=${a}&msg_rates_incr=${inc}`;
    const [ov, nodes] = await Promise.all([api(c, 'GET', '/api/overview' + qs), api(c, 'GET', '/api/nodes').catch(() => [])]);
    const qt = ov.queue_totals || {}, ot = ov.object_totals || {}, ms = ov.message_stats || {};
    return {
      version: ov.rabbitmq_version || ov.product_version || '', erlang: ov.erlang_version || '',
      cluster: ov.cluster_name || '', node: ov.node || '',
      messages: qt.messages || 0, ready: qt.messages_ready || 0, unacked: qt.messages_unacknowledged || 0,
      totals: { connections: ot.connections || 0, channels: ot.channels || 0, consumers: ot.consumers || 0, queues: ot.queues || 0, exchanges: ot.exchanges || 0 },
      rates: { publish: rate(ms.publish_details), deliver: rate(ms.deliver_get_details), ack: rate(ms.ack_details), confirm: rate(ms.confirm_details) },
      series: {
        lengths: { ready: gaugeSeries(qt.messages_ready_details), unacked: gaugeSeries(qt.messages_unacknowledged_details) },
        rates: { publish: rateSeries(ms.publish_details), deliver: rateSeries(ms.deliver_get_details), ack: rateSeries(ms.ack_details), redeliver: rateSeries(ms.redeliver_details) },
      },
      nodes: (Array.isArray(nodes) ? nodes : []).map((n) => ({
        name: n.name, running: n.running !== false, uptime: n.uptime || 0,
        memUsed: n.mem_used || 0, memLimit: n.mem_limit || 0, memAlarm: !!n.mem_alarm,
        diskFree: n.disk_free || 0, diskLimit: n.disk_free_limit || 0, diskAlarm: !!n.disk_free_alarm,
        fdUsed: n.fd_used || 0, fdTotal: n.fd_total || 0, procUsed: n.proc_used || 0, procTotal: n.proc_total || 0,
      })),
    };
  }));

  ipcMain.handle('rmq:vhosts', dataCall(async (c) => ({ vhosts: (await api(c, 'GET', '/api/vhosts')).map((v) => v.name) })));
  // spark: короткая история глубины per-очередь (12 точек за 2 мин) — для спарклайнов в списке
  ipcMain.handle('rmq:queues', dataCall(async (c, { vhost, spark }) => ({
    items: (await api(c, 'GET', (vhost ? '/api/queues/' + vh(vhost) : '/api/queues') + (spark ? '?lengths_age=120&lengths_incr=10' : ''))).map(slimQueue),
  })));
  ipcMain.handle('rmq:exchanges', dataCall(async (c, { vhost }) => ({ items: (await api(c, 'GET', vhost ? '/api/exchanges/' + vh(vhost) : '/api/exchanges')).map(slimExchange) })));
  ipcMain.handle('rmq:connections', dataCall(async (c) => ({ items: (await api(c, 'GET', '/api/connections')).map(slimConnection) })));
  ipcMain.handle('rmq:queueBindings', dataCall(async (c, { vhost, queue }) => ({
    items: (await api(c, 'GET', `/api/queues/${vh(vhost)}/${encodeURIComponent(queue)}/bindings`))
      .map((b) => ({ source: b.source, routingKey: b.routing_key, args: b.arguments || {} })),
  })));

  // Просмотр сообщений БЕЗ съедания: basic.get + requeue (ack_requeue_true).
  ipcMain.handle('rmq:peek', dataCall(async (c, { vhost, queue, count }) => {
    const msgs = await api(c, 'POST', `/api/queues/${vh(vhost)}/${encodeURIComponent(queue)}/get`,
      { count: Math.max(1, Math.min(200, +count || 10)), ackmode: 'ack_requeue_true', encoding: 'auto', truncate: 100000 });
    return { items: (msgs || []).map((m) => ({
      payload: m.payload, bytes: m.payload_bytes, encoding: m.payload_encoding,
      exchange: m.exchange, routingKey: m.routing_key, redelivered: !!m.redelivered,
      remaining: m.message_count, properties: m.properties || {},
    })) };
  }));

  // Публикация через management API. exchange '' (default) в URL зовётся amq.default.
  ipcMain.handle('rmq:publish', actionCall(async (c, { vhost, exchange, routingKey, payload, properties }) => {
    const ex = exchange ? encodeURIComponent(exchange) : 'amq.default';
    const r = await api(c, 'POST', `/api/exchanges/${vh(vhost)}/${ex}/publish`, {
      properties: properties && typeof properties === 'object' ? properties : {},
      routing_key: String(routingKey || ''), payload: String(payload == null ? '' : payload), payload_encoding: 'string',
    });
    return { routed: !!(r && r.routed) };
  }));

  ipcMain.handle('rmq:purge', actionCall(async (c, { vhost, queue }) =>
    { await api(c, 'DELETE', `/api/queues/${vh(vhost)}/${encodeURIComponent(queue)}/contents`); }));
  ipcMain.handle('rmq:deleteQueue', actionCall(async (c, { vhost, queue }) =>
    { await api(c, 'DELETE', `/api/queues/${vh(vhost)}/${encodeURIComponent(queue)}`); }));
  ipcMain.handle('rmq:killConnection', actionCall(async (c, { name }) =>
    { await api(c, 'DELETE', '/api/connections/' + encodeURIComponent(name)); }));

  // Live-tail: поток уходит в окно-владелец (e.sender); стоп — по кнопке или смерти окна.
  ipcMain.handle('rmq:tailStart', async (e, { id, vhost, exchange, routingKey, streamId } = {}) => {
    if (!streamId) return { ok: false, error: 'no streamId' };
    try {
      const c = connById(id);
      const sender = e.sender;
      const t = await openTail(c, { vhost, exchange, routingKey },
        (m) => { if (!sender.isDestroyed()) sender.send('rmq:tailData', { streamId, ...m }); },
        () => { if (tails.delete(streamId) && !sender.isDestroyed()) sender.send('rmq:tailExit', { streamId }); });
      tails.set(streamId, t);
      sender.once('destroyed', () => { const x = tails.get(streamId); if (x) { tails.delete(streamId); x.close(); } });
      return { ok: true };
    } catch (e2) { return { ok: false, error: String(e2.message || e2) }; }
  });
  ipcMain.on('rmq:tailStop', (_e, { streamId } = {}) => { const t = tails.get(streamId); if (t) { tails.delete(streamId); t.close(); } });

  return {};
}

module.exports = { registerRmqIpc, _test: { api, dec, enc, slimQueue, slimExchange, slimConnection, openTail } };
