// Бэкенд модуля «Kafka»: профили кластеров + операции через kafkajs (чистый JS, без нативных
// пересборок). Секреты шифрует safeStorage (схема enc/dec — как lib/db.js / lib/rmq.js).
// В отличие от RMQ, у Kafka НЕТ management HTTP API с готовыми рейтами/историей — метрики
// считаем сами: между вызовами overview/topics храним прошлый сэмпл оффсетов per-профиль
// и дифференцируем в сообщ./с (клип отрицательных на пересоздании топиков).
// Чтение сообщений у Kafka неразрушающее по природе; peek/live-tail ходят через ЭФЕМЕРНУЮ
// консюмер-группу (lite-peek-*/lite-tail-*) без коммитов, группа удаляется после себя.
//
// main.js: registerKafkaIpc({ ipcMain, safeStorage, getConnections, setConnections }).

const { Kafka, logLevel, ConfigResourceTypes, AssignerProtocol } = require('kafkajs');

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

// ---------------------------------------------------------------- клиенты
function parseBrokers(s) {
  return String(s || '').split(/[\s,;]+/).filter(Boolean)
    .map((b) => (b.includes(':') ? b : b + ':9092'));
}
function kafkaFor(c) {
  const brokers = parseBrokers(c.brokers);
  if (!brokers.length) throw new Error('Не заданы брокеры (host:port)');
  const cfg = {
    clientId: 'liteeditor', brokers, logLevel: logLevel.NOTHING,
    connectionTimeout: 8000, requestTimeout: 15000, retry: { retries: 2, initialRetryTime: 300 },
  };
  if (c.ssl) cfg.ssl = true;
  if (c.saslMechanism) cfg.sasl = { mechanism: c.saslMechanism, username: c.user || '', password: dec(c.passEnc) };
  return new Kafka(cfg);
}
function humanErr(e) {
  const s = String((e && e.message) || e);
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|broker.*not.*available|Connection error/i.test(s)) return 'Нет соединения с брокером (' + s.slice(0, 120) + ')';
  if (/SASL|authentication/i.test(s)) return 'Ошибка аутентификации: ' + s.slice(0, 160);
  if (/timeout|timed out/i.test(s)) return 'Таймаут — брокер не отвечает (проверь advertised.listeners)';
  return s.slice(0, 300);
}
function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('Таймаут: ' + what)), ms); })])
    .finally(() => clearTimeout(t));
}
async function mapLimit(arr, n, fn) {
  const out = new Array(arr.length); let i = 0;
  const worker = async () => { for (;;) { const k = i++; if (k >= arr.length) return; out[k] = await fn(arr[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, worker));
  return out;
}

// Пул admin-подключений per-профиль: полл каждые 3–5с — коннект на каждый вызов слишком дорог.
// Простаивающие >90с закрываются свипером; смена/удаление профиля дропает запись.
const admins = new Map(); // profileId -> { admin, ready, lastUsed }
async function adminFor(c) {
  const key = c.id || ('tmp' + Math.random());
  let ent = admins.get(key);
  if (!ent) {
    const admin = kafkaFor(c).admin();
    ent = { admin, ready: admin.connect(), lastUsed: Date.now() };
    admins.set(key, ent);
    ent.ready.catch(() => admins.delete(key)); // мёртвый коннект не должен залипнуть в пуле
  }
  ent.lastUsed = Date.now();
  await withTimeout(ent.ready, 10000, 'подключение к брокеру');
  return ent.admin;
}
function dropAdmin(id) {
  const ent = admins.get(id);
  if (ent) { admins.delete(id); ent.ready.then(() => ent.admin.disconnect()).catch(() => {}); }
}
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, ent] of admins) if (now - ent.lastUsed > 90000) dropAdmin(id);
}, 30000);
if (sweeper.unref) sweeper.unref();

// ---------------------------------------------------------------- метрики (сэмплы между вызовами)
const prevOv = new Map();     // profileId -> { t, totalEnd, totalCommitted }
const prevTopics = new Map(); // profileId -> { t, ends: { topic: totalEnd } }
const clipRate = (dv, dt) => (dt > 0 ? Math.max(0, dv / dt) : null);
const isInternalTopic = (t) => t.startsWith('__') || t.startsWith('_confluent') || t.startsWith('_schemas');
const isOwnGroup = (g) => /^lite-(peek|tail)-/.test(g);

// Оффсеты всех топиков одним заходом (с ограничением параллелизма). Возвращает
// Map topic -> [{partition, low, high}] — переиспользуется overview/topics/groups.
async function offsetsFor(admin, topics) {
  const m = new Map();
  await mapLimit(topics, 12, async (t) => {
    try {
      const offs = await admin.fetchTopicOffsets(t);
      m.set(t, offs.map((p) => ({ partition: p.partition, low: +p.low, high: +p.high })));
    } catch (_) { m.set(t, []); } // топик мог исчезнуть между list и fetch
  });
  return m;
}
// Лаг групп: committed по всем топикам группы + end-оффсеты (из общего кэша вызова).
async function groupLags(admin, groupIds, offCache) {
  const out = new Map(); // groupId -> { lag, topics: Set, committedSum }
  await mapLimit(groupIds, 6, async (g) => {
    try {
      const per = await admin.fetchOffsets({ groupId: g });
      let lag = 0, committedSum = 0; const topics = new Set();
      for (const t of per) {
        let offs = offCache.get(t.topic);
        if (!offs) { try { offs = (await admin.fetchTopicOffsets(t.topic)).map((p) => ({ partition: p.partition, low: +p.low, high: +p.high })); } catch (_) { offs = []; } offCache.set(t.topic, offs); }
        const high = new Map(offs.map((p) => [p.partition, p.high]));
        const low = new Map(offs.map((p) => [p.partition, p.low]));
        for (const p of t.partitions) {
          let c = +p.offset;
          if (c === -2) c = low.get(p.partition) ?? 0; // сентинел kafkajs resetOffsets(earliest) = начало лога
          if (c < 0) continue; // -1: нет коммита (или сброс на latest) — лаг не определён
          topics.add(t.topic); committedSum += c;
          const h = high.get(p.partition);
          if (h != null) lag += Math.max(0, h - c);
        }
      }
      out.set(g, { lag, topics, committedSum });
    } catch (_) { out.set(g, { lag: null, topics: new Set(), committedSum: 0 }); }
  });
  return out;
}

// ---------------------------------------------------------------- peek (последние/первые N)
// Чтение в Kafka никого не задевает; эфемерная группа без коммитов удаляется после себя.
async function peekMessages(c, { topic, count, from }) {
  const kafka = kafkaFor(c);
  const admin = await adminFor(c);
  const offs = (await withTimeout(admin.fetchTopicOffsets(topic), 10000, 'оффсеты топика'))
    .map((p) => ({ partition: p.partition, low: +p.low, high: +p.high }));
  const n = Math.max(1, Math.min(200, +count || 10));
  const withData = offs.filter((p) => p.high > p.low);
  if (!withData.length) return [];
  // Жадная раскладка квот: при скошенном распределении добираем из партиций, где сообщений
  // больше, — иначе peek(10) на партициях 11/1/18 вернул бы 9.
  const quota = new Map(withData.map((p) => [p.partition, 0]));
  let remaining = n, progress = true;
  while (remaining > 0 && progress) {
    progress = false;
    for (const p of withData) {
      if (!remaining) break;
      if (quota.get(p.partition) < p.high - p.low) { quota.set(p.partition, quota.get(p.partition) + 1); remaining--; progress = true; }
    }
  }
  const plan = withData.map((p) => {
    const q = quota.get(p.partition);
    const start = from === 'begin' ? p.low : Math.max(p.low, p.high - q);
    const until = from === 'begin' ? Math.min(p.high, p.low + q) : p.high;
    return { partition: p.partition, start, until, expect: until - start };
  }).filter((p) => p.expect > 0);
  const expectTotal = plan.reduce((s, p) => s + p.expect, 0);
  if (!expectTotal) return [];
  const gid = 'lite-peek-' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  const consumer = kafka.consumer({ groupId: gid, sessionTimeout: 10000, allowAutoTopicCreation: false });
  const got = [];
  try {
    await withTimeout(consumer.connect(), 8000, 'подключение консюмера');
    await consumer.subscribe({ topic, fromBeginning: true });
    const untilBy = new Map(plan.map((p) => [p.partition, p.until]));
    await new Promise((resolve, reject) => {
      const guard = setTimeout(resolve, 8000); // стоп-кран: медленный брокер не подвешивает вызов
      consumer.run({
        autoCommit: false,
        eachMessage: async ({ partition, message }) => {
          const until = untilBy.get(partition);
          if (until == null || +message.offset >= until) return;
          let value = message.value ? message.value.toString('utf8') : '';
          if (value.length > 20000) value = value.slice(0, 20000) + '\n… [обрезано]';
          const headers = {};
          for (const [k, v] of Object.entries(message.headers || {})) headers[k] = v == null ? '' : v.toString('utf8').slice(0, 500);
          got.push({
            partition, offset: message.offset, ts: +message.timestamp || Date.now(),
            key: message.key ? message.key.toString('utf8').slice(0, 500) : null,
            value, size: message.value ? message.value.length : 0, headers,
          });
          if (got.length >= expectTotal) { clearTimeout(guard); resolve(); }
        },
      }).catch((e) => { clearTimeout(guard); reject(e); });
      for (const p of plan) consumer.seek({ topic, partition: p.partition, offset: String(p.start) });
    });
  } finally {
    try { await consumer.disconnect(); } catch (_) {}
    try { await admin.deleteGroups([gid]); } catch (_) {} // не оставляем следов в списке групп
  }
  got.sort((a, b) => (from === 'begin' ? a.ts - b.ts : b.ts - a.ts));
  return got.slice(0, n);
}

// ---------------------------------------------------------------- live-tail
// Поток топика с текущего момента (fromBeginning:false, группа новая → с конца). Копии
// сообщений идут только нам; настоящие консюмер-группы ничего не замечают.
const tails = new Map(); // streamId -> { close }

async function openTail(c, { topic }, onMsg, onClose) {
  if (!topic) throw new Error('Не выбран топик');
  const kafka = kafkaFor(c);
  const gid = 'lite-tail-' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  const consumer = kafka.consumer({ groupId: gid, sessionTimeout: 15000, allowAutoTopicCreation: false });
  let closed = false;
  const cleanup = async () => {
    if (closed) return; closed = true;
    try { await consumer.disconnect(); } catch (_) {}
    try { const admin = await adminFor(c); await admin.deleteGroups([gid]); } catch (_) {}
  };
  try {
    await withTimeout(consumer.connect(), 8000, 'подключение консюмера');
    consumer.on(consumer.events.CRASH, () => { cleanup(); if (onClose) onClose(); });
    await consumer.subscribe({ topic, fromBeginning: false });
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ partition, message }) => {
        let value = message.value ? message.value.toString('utf8') : '';
        if (value.length > 20000) value = value.slice(0, 20000) + '\n… [обрезано]';
        const headers = {};
        for (const [k, v] of Object.entries(message.headers || {})) headers[k] = v == null ? '' : v.toString('utf8').slice(0, 500);
        onMsg({
          partition, offset: message.offset, ts: +message.timestamp || Date.now(),
          key: message.key ? message.key.toString('utf8').slice(0, 500) : null,
          value, size: message.value ? message.value.length : 0, headers,
        });
      },
    });
  } catch (e) { await cleanup(); throw e; }
  return { close: cleanup };
}

// ---------------------------------------------------------------- IPC
// kafkajs ≤2.2.4 на первом коннекте планирует setTimeout(throttledUntil(-1) − Date.now()) —
// Node клампит до 1 мс, но кидает TimeoutNegativeWarning, а обёртка console в logger.js
// превращает его в [ERROR] в логе КАЖДОЙ сессии с Kafka. Гасим ТОЛЬКО это предупреждение:
// дефолтный принтер Node — обычный listener 'warning', переустанавливаем его с фильтром.
let warnFilterInstalled = false;
function muteKafkajsTimeoutWarning() {
  if (warnFilterInstalled) return;
  warnFilterInstalled = true;
  try {
    const prev = process.listeners('warning');
    if (!prev.length) return; // печать не через listener — фильтровать нечего, не трогаем
    process.removeAllListeners('warning');
    process.on('warning', (w) => {
      if (w && w.name === 'TimeoutNegativeWarning') return;
      for (const h of prev) { try { h(w); } catch (_) {} }
    });
  } catch (_) {}
}

function registerKafkaIpc({ ipcMain, safeStorage, getConnections, setConnections }) {
  _safe = safeStorage; _get = getConnections; _set = setConnections;
  muteKafkajsTimeoutWarning();

  ipcMain.handle('kafka:list', () => ({ connections: publicList(), secure: !!(safeStorage && safeStorage.isEncryptionAvailable()) }));

  // Создание/правка профиля. Пароль приходит только когда меняется; нет — оставляем блоб.
  ipcMain.handle('kafka:save', (_e, { conn } = {}) => {
    if (!conn || !conn.name) return { error: 'нет данных профиля' };
    const list = loadConns();
    const idx = conn.id ? list.findIndex((x) => x.id === conn.id) : -1;
    const prev = idx >= 0 ? list[idx] : {};
    const rec = { ...prev, ...conn };
    delete rec.hasPass;
    if (conn.password != null) rec.passEnc = conn.password ? enc(conn.password) : '';
    delete rec.password;
    if (!rec.id) rec.id = 'kf' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
    if (idx >= 0) list[idx] = rec; else list.push(rec);
    saveConns(list);
    dropAdmin(rec.id); // конфиг мог поменяться — пул должен переподключиться
    return { ok: true, id: rec.id, connection: publicConn(rec) };
  });
  ipcMain.handle('kafka:delete', (_e, { id } = {}) => {
    saveConns(loadConns().filter((x) => x.id !== id)); dropAdmin(id); return { ok: true };
  });

  // Тест: поля формы поверх сохранённых; пароль — введённый, иначе сохранённый блоб.
  ipcMain.handle('kafka:test', async (_e, { conn } = {}) => {
    const saved = conn && conn.id ? (loadConns().find((x) => x.id === conn.id) || {}) : {};
    const cfg = { ...saved, ...conn };
    cfg.passEnc = conn && conn.password != null ? (conn.password ? enc(conn.password) : '') : (saved.passEnc || '');
    const admin = kafkaFor(cfg).admin();
    try {
      await withTimeout(admin.connect(), 10000, 'подключение');
      const d = await withTimeout(admin.describeCluster(), 10000, 'describeCluster');
      return { ok: true, version: `кластер ${d.clusterId || '?'} · брокеров: ${(d.brokers || []).length}`, brokers: (d.brokers || []).length };
    } catch (e) { return { ok: false, error: humanErr(e) }; }
    finally { admin.disconnect().catch(() => {}); }
  });

  const dataCall = (fn) => async (_e, args = {}) => {
    try { return await fn(connById(args.id), args); }
    catch (e) { dropAdmin(args.id); return { error: humanErr(e) }; }
  };
  const actionCall = (fn) => async (_e, args = {}) => {
    try { const r = await fn(connById(args.id), args); return { ok: true, ...(r || {}) }; }
    catch (e) { return { ok: false, error: humanErr(e) }; }
  };

  // Обзор: брокеры/контроллер + счётчики + скорости (dis-дифференцирование суммарных
  // оффсетов между вызовами) + суммарный лаг групп. График копит рендерер (у Kafka нет истории).
  ipcMain.handle('kafka:overview', dataCall(async (c) => {
    const admin = await adminFor(c);
    const [d, topicsAll, lg] = await Promise.all([
      withTimeout(admin.describeCluster(), 12000, 'describeCluster'),
      withTimeout(admin.listTopics(), 12000, 'список топиков'),
      withTimeout(admin.listGroups(), 12000, 'список групп').catch(() => ({ groups: [] })),
    ]);
    const topics = topicsAll.filter((t) => !isInternalTopic(t));
    const meta = await withTimeout(admin.fetchTopicMetadata({ topics: topics.slice(0, 500) }), 15000, 'метаданные топиков').catch(() => ({ topics: [] }));
    let partitionCount = 0, underReplicated = 0;
    for (const t of meta.topics || []) {
      partitionCount += (t.partitions || []).length;
      for (const p of t.partitions || []) if ((p.isr || []).length < (p.replicas || []).length) underReplicated++;
    }
    const offCache = await offsetsFor(admin, topics.slice(0, 500));
    let totalMessages = 0, totalEnd = 0;
    for (const offs of offCache.values()) for (const p of offs) { totalMessages += Math.max(0, p.high - p.low); totalEnd += p.high; }
    const groupIds = (lg.groups || []).map((g) => g.groupId).filter((g) => !isOwnGroup(g));
    let totalLag = null, totalCommitted = null;
    if (groupIds.length && groupIds.length <= 50) { // на огромных кластерах лаг в обзоре пропускаем
      const lags = await groupLags(admin, groupIds, offCache);
      totalLag = 0; totalCommitted = 0;
      for (const v of lags.values()) { if (v.lag != null) totalLag += v.lag; totalCommitted += v.committedSum; }
    }
    const now = Date.now();
    const prev = prevOv.get(c.id);
    const produceRate = prev ? clipRate(totalEnd - prev.totalEnd, (now - prev.t) / 1000) : null;
    const consumeRate = (prev && prev.totalCommitted != null && totalCommitted != null)
      ? clipRate(totalCommitted - prev.totalCommitted, (now - prev.t) / 1000) : null;
    prevOv.set(c.id, { t: now, totalEnd, totalCommitted });
    return {
      clusterId: d.clusterId || '', controllerId: d.controller,
      brokers: (d.brokers || []).map((b) => ({ nodeId: b.nodeId, addr: b.host + ':' + b.port, controller: b.nodeId === d.controller })),
      topicCount: topics.length, internalCount: topicsAll.length - topics.length,
      partitionCount, underReplicated, groupCount: groupIds.length,
      totalMessages, produceRate, consumeRate, totalLag, ts: now,
    };
  }));

  // Топики: партиции/RF/ISR + сообщения (Σ high-low) + In/с из дельты end-оффсетов между поллами.
  ipcMain.handle('kafka:topics', dataCall(async (c, { internal } = {}) => {
    const admin = await adminFor(c);
    const all = await withTimeout(admin.listTopics(), 12000, 'список топиков');
    const names = all.filter((t) => (internal ? true : !isInternalTopic(t)));
    const meta = await withTimeout(admin.fetchTopicMetadata({ topics: names.slice(0, 500) }), 15000, 'метаданные топиков').catch(() => ({ topics: [] }));
    const offCache = await offsetsFor(admin, names.slice(0, 500));
    const now = Date.now();
    const prev = prevTopics.get(c.id);
    const ends = {};
    const items = (meta.topics || []).map((t) => {
      const parts = t.partitions || [];
      const offs = offCache.get(t.name) || [];
      let messages = 0, totalEnd = 0;
      for (const p of offs) { messages += Math.max(0, p.high - p.low); totalEnd += p.high; }
      ends[t.name] = totalEnd;
      const ur = parts.filter((p) => (p.isr || []).length < (p.replicas || []).length).length;
      const rate = prev && prev.ends[t.name] != null ? clipRate(totalEnd - prev.ends[t.name], (now - prev.t) / 1000) : null;
      return {
        name: t.name, internal: isInternalTopic(t.name),
        partitions: parts.length, replication: parts.length ? (parts[0].replicas || []).length : 0,
        underReplicated: ur, messages, totalEnd, rate,
      };
    });
    prevTopics.set(c.id, { t: now, ends });
    return { items };
  }));

  // Детали топика: партиции (лидер/реплики/ISR/оффсеты) + конфиги (retention и весь список).
  ipcMain.handle('kafka:topicDetail', dataCall(async (c, { topic }) => {
    const admin = await adminFor(c);
    const [meta, offs, cfg] = await Promise.all([
      withTimeout(admin.fetchTopicMetadata({ topics: [topic] }), 12000, 'метаданные'),
      withTimeout(admin.fetchTopicOffsets(topic), 12000, 'оффсеты'),
      withTimeout(admin.describeConfigs({ resources: [{ type: ConfigResourceTypes.TOPIC, name: topic }], includeSynonyms: false }), 12000, 'конфиги').catch(() => null),
    ]);
    const offBy = new Map(offs.map((p) => [p.partition, p]));
    const t = (meta.topics || [])[0] || { partitions: [] };
    const partitions = (t.partitions || []).map((p) => {
      const o = offBy.get(p.partitionId) || {};
      return {
        partition: p.partitionId, leader: p.leader, replicas: p.replicas || [], isr: p.isr || [],
        low: o.low != null ? +o.low : null, high: o.high != null ? +o.high : null,
        messages: o.low != null ? Math.max(0, +o.high - +o.low) : null,
      };
    }).sort((a, b) => a.partition - b.partition);
    const entries = ((cfg && cfg.resources && cfg.resources[0] && cfg.resources[0].configEntries) || [])
      .map((e2) => ({ name: e2.configName, value: e2.isSensitive ? '•••' : e2.configValue, isDefault: !!e2.isDefault, readOnly: !!e2.readOnly }))
      .sort((a, b) => (a.isDefault - b.isDefault) || a.name.localeCompare(b.name));
    return { partitions, configs: entries };
  }));

  ipcMain.handle('kafka:createTopic', actionCall(async (c, { topic, partitions, replication, retentionMs, cleanupPolicy }) => {
    if (!topic) throw new Error('нет имени топика');
    const admin = await adminFor(c);
    const configEntries = [];
    if (retentionMs) configEntries.push({ name: 'retention.ms', value: String(retentionMs) });
    if (cleanupPolicy) configEntries.push({ name: 'cleanup.policy', value: cleanupPolicy });
    const ok = await withTimeout(admin.createTopics({
      waitForLeaders: true,
      topics: [{ topic, numPartitions: Math.max(1, +partitions || 1), replicationFactor: Math.max(1, +replication || 1), configEntries }],
    }), 20000, 'создание топика');
    if (!ok) throw new Error('Топик уже существует');
  }));
  ipcMain.handle('kafka:deleteTopic', actionCall(async (c, { topic }) =>
    { const admin = await adminFor(c); await withTimeout(admin.deleteTopics({ topics: [topic] }), 20000, 'удаление топика'); prevTopics.delete(c.id); }));
  ipcMain.handle('kafka:addPartitions', actionCall(async (c, { topic, count }) =>
    { const admin = await adminFor(c); await withTimeout(admin.createPartitions({ topicPartitions: [{ topic, count: Math.max(1, +count || 1) }] }), 15000, 'добавление партиций'); }));
  // «Очистить топик» — DeleteRecords до конца лога каждой партиции (offset -1 = high watermark).
  ipcMain.handle('kafka:purgeTopic', actionCall(async (c, { topic }) => {
    const admin = await adminFor(c);
    const offs = await withTimeout(admin.fetchTopicOffsets(topic), 12000, 'оффсеты');
    await withTimeout(admin.deleteTopicRecords({
      topic, partitions: offs.map((p) => ({ partition: p.partition, offset: '-1' })),
    }), 20000, 'очистка топика');
  }));
  ipcMain.handle('kafka:setTopicConfig', actionCall(async (c, { topic, name, value }) => {
    if (!name) throw new Error('нет имени параметра');
    const admin = await adminFor(c);
    await withTimeout(admin.alterConfigs({
      validateOnly: false,
      resources: [{ type: ConfigResourceTypes.TOPIC, name: topic, configEntries: [{ name, value: String(value) }] }],
    }), 15000, 'изменение конфига');
  }));

  // Группы: состояние/участники + суммарный лаг (комбинация fetchOffsets + end-оффсеты).
  ipcMain.handle('kafka:groups', dataCall(async (c) => {
    const admin = await adminFor(c);
    const lg = await withTimeout(admin.listGroups(), 12000, 'список групп');
    const ids = (lg.groups || []).map((g) => g.groupId).filter((g) => !isOwnGroup(g)).slice(0, 100);
    if (!ids.length) return { items: [] };
    const desc = await withTimeout(admin.describeGroups(ids), 15000, 'describeGroups').catch(() => ({ groups: [] }));
    const stateBy = new Map((desc.groups || []).map((g) => [g.groupId, { state: g.state || '', members: (g.members || []).length }]));
    const offCache = new Map();
    const lags = await groupLags(admin, ids, offCache);
    return { items: ids.map((g) => {
      const st = stateBy.get(g) || { state: '', members: 0 };
      const lv = lags.get(g) || { lag: null, topics: new Set() };
      return { groupId: g, state: st.state, members: st.members, topics: lv.topics.size, lag: lv.lag };
    }) };
  }));

  // Детали группы: per-топик/партиция committed/end/lag + участники с их назначениями.
  ipcMain.handle('kafka:groupDetail', dataCall(async (c, { groupId }) => {
    const admin = await adminFor(c);
    const [desc, per] = await Promise.all([
      withTimeout(admin.describeGroups([groupId]), 12000, 'describeGroups').catch(() => ({ groups: [] })),
      withTimeout(admin.fetchOffsets({ groupId }), 15000, 'оффсеты группы'),
    ]);
    const rows = [];
    for (const t of per) {
      let offs = [];
      try { offs = await admin.fetchTopicOffsets(t.topic); } catch (_) {}
      const high = new Map(offs.map((p) => [p.partition, +p.high]));
      const low = new Map(offs.map((p) => [p.partition, +p.low]));
      for (const p of t.partitions) {
        let committed = +p.offset;
        if (committed === -2) committed = low.get(p.partition) ?? 0; // сентинел resetOffsets(earliest)
        if (committed < 0) continue;
        const end = high.get(p.partition);
        rows.push({ topic: t.topic, partition: p.partition, committed, end: end != null ? end : null, lag: end != null ? Math.max(0, end - committed) : null });
      }
    }
    rows.sort((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition);
    const g = (desc.groups || [])[0] || {};
    const members = (g.members || []).map((mb) => {
      let assign = '';
      try {
        const a = AssignerProtocol.MemberAssignment.decode(mb.memberAssignment);
        if (a && a.assignment) assign = Object.entries(a.assignment).map(([t, ps]) => `${t}[${ps.join(',')}]`).join(' ');
      } catch (_) {}
      return { clientId: mb.clientId || '', host: mb.clientHost || '', assign };
    });
    return { state: g.state || '', protocol: g.protocol || '', members, rows };
  }));

  // Сброс оффсетов (только у пустой группы — иначе брокер откажет, ошибку показываем как есть).
  ipcMain.handle('kafka:resetOffsets', actionCall(async (c, { groupId, topic, to }) => {
    const admin = await adminFor(c);
    await withTimeout(admin.resetOffsets({ groupId, topic, earliest: to === 'earliest' }), 15000, 'сброс оффсетов');
  }));
  ipcMain.handle('kafka:deleteGroup', actionCall(async (c, { groupId }) =>
    { const admin = await adminFor(c); await withTimeout(admin.deleteGroups([groupId]), 15000, 'удаление группы'); }));

  // Просмотр сообщений (чтение в Kafka неразрушающее; эфемерная группа удаляется после себя).
  ipcMain.handle('kafka:peek', dataCall(async (c, { topic, count, from }) => ({
    items: await peekMessages(c, { topic, count, from: from === 'begin' ? 'begin' : 'end' }),
  })));

  // Публикация: транзиентный producer (отправка — редкая ручная операция, пул не нужен).
  ipcMain.handle('kafka:produce', actionCall(async (c, { topic, key, value, headers, partition }) => {
    const producer = kafkaFor(c).producer({ allowAutoTopicCreation: false });
    try {
      await withTimeout(producer.connect(), 8000, 'подключение продюсера');
      const msg = { value: String(value == null ? '' : value) };
      if (key) msg.key = String(key);
      if (partition !== '' && partition != null && Number.isInteger(+partition)) msg.partition = +partition;
      if (headers && typeof headers === 'object' && Object.keys(headers).length) msg.headers = headers;
      const r = await withTimeout(producer.send({ topic, messages: [msg], acks: -1 }), 15000, 'отправка');
      const m0 = (r && r[0]) || {};
      return { partition: m0.partition != null ? m0.partition : null, offset: m0.baseOffset != null ? m0.baseOffset : null };
    } finally { producer.disconnect().catch(() => {}); }
  }));

  // Live-tail: поток уходит в окно-владелец (e.sender); стоп — по кнопке или смерти окна.
  ipcMain.handle('kafka:tailStart', async (e, { id, topic, streamId } = {}) => {
    if (!streamId) return { ok: false, error: 'no streamId' };
    try {
      const c = connById(id);
      const sender = e.sender;
      const t = await openTail(c, { topic },
        (m) => { if (!sender.isDestroyed()) sender.send('kafka:tailData', { streamId, ...m }); },
        () => { if (tails.delete(streamId) && !sender.isDestroyed()) sender.send('kafka:tailExit', { streamId }); });
      tails.set(streamId, t);
      sender.once('destroyed', () => { const x = tails.get(streamId); if (x) { tails.delete(streamId); x.close(); } });
      return { ok: true };
    } catch (e2) { return { ok: false, error: humanErr(e2) }; }
  });
  ipcMain.on('kafka:tailStop', (_e, { streamId } = {}) => { const t = tails.get(streamId); if (t) { tails.delete(streamId); t.close(); } });

  return {};
}

module.exports = { registerKafkaIpc, _test: { parseBrokers, humanErr, enc, dec, peekMessages, openTail, kafkaFor, adminFor, dropAdmin } };
