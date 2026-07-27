// Тест детекта сервисов в контейнере (связки «Контейнеры» → модули БД/RabbitMQ/Kafka/Хранилища/Мониторинг).
// Цена ошибки здесь — молчаливая: неверный префилл выглядит как рабочая форма подключения,
// пользователь узнаёт о нём только по отказу коннекта.
// Запуск: node test/dbdetect.test.js  (без зависимостей, чистый node).
const assert = require('assert');
const d = require('../lib/dbdetect.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; }

// --- guessDbKind: образ важнее портов -------------------------------------------
eq(d.guessDbKind('postgres:16', ''), 'postgres', 'официальный postgres');
eq(d.guessDbKind('postgis/postgis:15-3.4', ''), 'postgres', 'postgis');
eq(d.guessDbKind('pgvector/pgvector:pg16', ''), 'postgres', 'pgvector');
eq(d.guessDbKind('timescale/timescaledb:latest-pg15', ''), 'postgres', 'timescaledb');
eq(d.guessDbKind('mysql:8', ''), 'mysql', 'mysql');
eq(d.guessDbKind('mariadb:11', ''), 'mysql', 'mariadb приводится к mysql');
eq(d.guessDbKind('percona:8.0', ''), 'mysql', 'percona');

// Инструменты рядом с СУБД серверами не являются — иначе UI предложит к ним подключиться.
eq(d.guessDbKind('proxysql/proxysql:2.5', ''), null, 'proxysql не сервер');
eq(d.guessDbKind('percona/percona-toolkit:latest', ''), null, 'percona-toolkit не сервер');

// --- guessDbKind по портам: docker и podman печатают их по-разному ---------------
eq(d.guessDbKind('myapp/custom:1', '0.0.0.0:5434->5432/tcp'), 'postgres', 'docker-формат');
eq(d.guessDbKind('myapp/custom:1', '5434:5432'), 'postgres', 'podman-формат');
eq(d.guessDbKind('myapp/custom:1', '0.0.0.0:3307->3306/tcp, :::3307->3306/tcp'), 'mysql', 'порт в списке');
eq(d.guessDbKind('myapp/custom:1', '0.0.0.0:15432->15432/tcp'), null, 'похожий, но чужой порт');
eq(d.guessDbKind('', ''), null, 'пустой ввод');
eq(d.guessDbKind(null, null), null, 'null не роняет');

// --- dbPrefillFromInspect: мусор на входе ---------------------------------------
eq(d.dbPrefillFromInspect(null, 'docker'), null, 'null');
eq(d.dbPrefillFromInspect('строка', 'docker'), null, 'не объект');
eq(d.dbPrefillFromInspect({}, 'docker'), null, 'пустой inspect');

// --- postgres: креды из env ------------------------------------------------------
const pg = d.dbPrefillFromInspect({
  Name: '/pagila-db',
  Config: { Image: 'postgres:16', Env: ['POSTGRES_PASSWORD=secret', 'POSTGRES_DB=pagila'] },
  State: { Running: true },
  NetworkSettings: { Ports: { '5432/tcp': [{ HostPort: '5433' }] } },
}, 'podman');
eq(pg.kind, 'postgres', 'вид БД');
ok(pg.published === true, 'порт опубликован');
ok(pg.running === true, 'контейнер запущен');
ok(pg.passwordUnknown === false, 'пароль известен');
eq(pg.prefill.name, 'pagila-db', 'ведущий слеш в Name отброшен');
eq(pg.prefill.port, 5433, 'хост-порт, а не контейнерный');
eq(pg.prefill.user, 'postgres', 'дефолтный пользователь');
eq(pg.prefill.password, 'secret', 'пароль из env');
eq(pg.prefill.database, 'pagila', 'база из env');
eq(pg.prefill.source, 'podman:pagila-db', 'источник с движком');

// bitnami-семейство именует переменные иначе
const bitnami = d.dbPrefillFromInspect({
  Name: 'bn', Config: { Image: 'bitnami/postgresql:16', Env: ['POSTGRESQL_USERNAME=app', 'POSTGRESQL_PASSWORD=pw'] },
}, 'docker');
eq(bitnami.prefill.user, 'app', 'POSTGRESQL_USERNAME');
eq(bitnami.prefill.password, 'pw', 'POSTGRESQL_PASSWORD');
eq(bitnami.prefill.database, 'app', 'без POSTGRES_DB база = имя пользователя');

// trust — валидный ПУСТОЙ пароль, его нельзя путать с «пароль неизвестен»
const trust = d.dbPrefillFromInspect({
  Name: 't', Config: { Image: 'postgres:16', Env: ['POSTGRES_HOST_AUTH_METHOD=trust'] },
}, 'docker');
eq(trust.prefill.password, '', 'trust → пустой пароль');
ok(trust.passwordUnknown === false, 'пустой пароль известен');

// секрет вне env (…_FILE) — пароль спрашиваем у пользователя, а не подставляем пустой
const secret = d.dbPrefillFromInspect({
  Name: 's', Config: { Image: 'postgres:16', Env: ['POSTGRES_PASSWORD_FILE=/run/secrets/pw'] },
}, 'docker');
ok(secret.passwordUnknown === true, 'POSTGRES_PASSWORD_FILE → пароль неизвестен');
eq(secret.prefill.password, null, 'неизвестный пароль не подставляется');

// --- mysql/mariadb: приоритет непривилегированного пользователя ------------------
const my = d.dbPrefillFromInspect({
  Name: '/shop', Config: { Image: 'mysql:8', Env: ['MYSQL_USER=app', 'MYSQL_PASSWORD=apw', 'MYSQL_ROOT_PASSWORD=rpw', 'MYSQL_DATABASE=shop'] },
}, 'docker');
eq(my.prefill.user, 'app', 'MYSQL_USER важнее root');
eq(my.prefill.password, 'apw', 'пароль пользователя, не root');
eq(my.prefill.database, 'shop', 'база из env');

const myRoot = d.dbPrefillFromInspect({
  Name: 'r', Config: { Image: 'mariadb:11', Env: ['MARIADB_ROOT_PASSWORD=rpw'] },
}, 'docker');
eq(myRoot.prefill.user, 'root', 'без MYSQL_USER — root');
eq(myRoot.prefill.password, 'rpw', 'MARIADB_ROOT_PASSWORD');
eq(myRoot.prefill.database, '', 'база не угадывается');

const myRandom = d.dbPrefillFromInspect({
  Name: 'rnd', Config: { Image: 'mysql:8', Env: ['MYSQL_RANDOM_ROOT_PASSWORD=yes', 'MYSQL_ROOT_PASSWORD=ignored'] },
}, 'docker');
ok(myRandom.passwordUnknown === true, 'случайный root-пароль неизвестен даже при заданном MYSQL_ROOT_PASSWORD');

const myEmpty = d.dbPrefillFromInspect({
  Name: 'e', Config: { Image: 'mysql:8', Env: ['MYSQL_ALLOW_EMPTY_PASSWORD=1'] },
}, 'docker');
eq(myEmpty.prefill.password, '', 'ALLOW_EMPTY → пустой пароль');

// --- кастомный образ: детект по env, затем по объявленным портам -----------------
const byEnv = d.dbPrefillFromInspect({
  Name: 'c', Config: { Image: 'registry.local/my-app:1', Env: ['POSTGRES_USER=u'] },
}, 'docker');
eq(byEnv.kind, 'postgres', 'кастомный образ распознан по env');

const byExposed = d.dbPrefillFromInspect({
  Name: 'c2', Config: { Image: 'registry.local/my-app:1', Env: [], ExposedPorts: { '3306/tcp': {} } },
}, 'docker');
eq(byExposed.kind, 'mysql', 'кастомный образ распознан по ExposedPorts');
ok(byExposed.published === false, 'порт не опубликован наружу');
eq(byExposed.prefill.port, 3306, 'фолбэк на контейнерный порт');

// --- hostPortFor: у остановленного контейнера маппинг живёт в HostConfig ---------
const stopped = d.dbPrefillFromInspect({
  Name: 'st', Config: { Image: 'postgres:16', Env: ['POSTGRES_PASSWORD=p'] },
  State: { Running: false },
  NetworkSettings: { Ports: {} },
  HostConfig: { PortBindings: { '5432/tcp': [{ HostPort: '5440' }] } },
}, 'docker');
eq(stopped.prefill.port, 5440, 'фолбэк на HostConfig.PortBindings');
ok(stopped.running === false, 'контейнер остановлен');

// Id как запасное имя, когда Name пуст
const byId = d.dbPrefillFromInspect({
  Id: 'abcdef0123456789', Config: { Image: 'postgres:16', Env: ['POSTGRES_PASSWORD=p'] },
}, 'docker');
eq(byId.prefill.name, 'abcdef012345', 'имя из первых 12 символов Id');

// --- очередь сообщений ------------------------------------------------------------
eq(d.guessMqKind('rabbitmq:3-management', ''), 'rabbitmq', 'rabbitmq по образу');
eq(d.guessMqKind('confluentinc/cp-kafka:7.5.0', ''), 'kafka', 'kafka по образу');
eq(d.guessMqKind('redpandadata/redpanda:latest', ''), 'kafka', 'redpanda = kafka');
eq(d.guessMqKind('custom', '0.0.0.0:15672->15672/tcp'), 'rabbitmq', 'rabbitmq по management-порту');
eq(d.guessMqKind('custom', '0.0.0.0:29092->29092/tcp'), 'kafka', 'kafka по внешнему листенеру');
eq(d.guessMqKind('custom', '0.0.0.0:1234->1234/tcp'), null, 'чужой порт');

const rmq = d.rmqPrefillFromInspect({
  Name: '/broker', Config: { Image: 'rabbitmq:3-management', Env: ['RABBITMQ_DEFAULT_USER=admin', 'RABBITMQ_DEFAULT_PASS=pw', 'RABBITMQ_DEFAULT_VHOST=/app'] },
  State: { Running: true },
  NetworkSettings: { Ports: { '15672/tcp': [{ HostPort: '15673' }], '5672/tcp': [{ HostPort: '5673' }] } },
}, 'docker');
eq(rmq.prefill.user, 'admin', 'пользователь из env');
eq(rmq.prefill.password, 'pw', 'пароль из env');
eq(rmq.prefill.vhost, '/app', 'vhost из env');
eq(rmq.prefill.port, 15673, 'management-порт с хоста');
eq(rmq.prefill.amqpPort, 5673, 'amqp-порт с хоста');
ok(rmq.published === true && rmq.amqpPublished === true, 'оба порта опубликованы');

const rmqDefault = d.rmqPrefillFromInspect({ Name: 'b2', Config: { Image: 'rabbitmq:3' } }, 'docker');
eq(rmqDefault.prefill.user, 'guest', 'дефолт guest');
eq(rmqDefault.prefill.password, 'guest', 'дефолтный пароль guest');
eq(rmqDefault.prefill.vhost, '/', 'дефолтный vhost');
ok(rmqDefault.published === false, 'без маппинга management недоступен');

// без management-порта образ RabbitMQ не опознаётся по одним ExposedPorts
eq(d.rmqPrefillFromInspect({ Name: 'x', Config: { Image: 'custom', ExposedPorts: { '5672/tcp': {} } } }, 'docker'), null,
  'только amqp-порт — не RabbitMQ');
ok(d.rmqPrefillFromInspect({ Name: 'x', Config: { Image: 'custom', ExposedPorts: { '5672/tcp': {}, '15672/tcp': {} } } }, 'docker') !== null,
  'amqp + management — RabbitMQ');

// --- Kafka: advertised.listeners важнее маппинга портов --------------------------
const kafkaAdv = d.kafkaPrefillFromInspect({
  Name: '/kfk', Config: { Image: 'confluentinc/cp-kafka:7.5.0', Env: ['KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://kafka:9092,EXTERNAL://localhost:29092'] },
  NetworkSettings: { Ports: { '9092/tcp': [{ HostPort: '9092' }] } },
}, 'docker');
eq(kafkaAdv.prefill.brokers, '127.0.0.1:29092', 'порт из advertised-листенера на localhost');

const kafkaMapped = d.kafkaPrefillFromInspect({
  Name: 'k2', Config: { Image: 'bitnami/kafka:3.7', Env: [] },
  NetworkSettings: { Ports: { '9094/tcp': [{ HostPort: '9095' }] } },
}, 'docker');
eq(kafkaMapped.prefill.brokers, '127.0.0.1:9095', 'порт из маппинга, когда advertised нет');

const kafkaInternal = d.kafkaPrefillFromInspect({
  Name: 'k3', Config: { Image: 'confluentinc/cp-kafka:7.5.0', Env: ['KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://kafka-internal:9092'] },
}, 'docker');
eq(kafkaInternal.prefill.brokers, '127.0.0.1:9092', 'внутреннее имя сети → дефолтный порт');
ok(kafkaInternal.published === false, 'снаружи не достучаться');

// --- Хранилище (MinIO) -----------------------------------------------------------
eq(d.guessStorageKind('minio/minio:latest'), 'minio', 'minio по образу');
eq(d.guessStorageKind('nginx'), null, 'не minio');

const minio = d.storagePrefillFromInspect({
  Name: '/s3', Config: { Image: 'minio/minio', Env: ['MINIO_ROOT_USER=admin', 'MINIO_ROOT_PASSWORD=pw'] },
  NetworkSettings: { Ports: { '9000/tcp': [{ HostPort: '9001' }] } },
}, 'podman');
eq(minio.prefill.endpoint, 'http://127.0.0.1:9001', 'эндпоинт по хост-порту');
eq(minio.prefill.accessKeyId, 'admin', 'ключ доступа');
eq(minio.prefill.secretKey, 'pw', 'секрет');
ok(minio.prefill.forcePathStyle === true, 'path-style для MinIO');

const minioLegacy = d.storagePrefillFromInspect({
  Name: 'l', Config: { Image: 'custom', Env: ['MINIO_ACCESS_KEY=ak', 'MINIO_SECRET_KEY=sk'] },
}, 'docker');
eq(minioLegacy.prefill.accessKeyId, 'ak', 'легаси-ключ');
eq(minioLegacy.prefill.secretKey, 'sk', 'легаси-секрет');
eq(minioLegacy.prefill.endpoint, 'http://127.0.0.1:9000', 'дефолтный порт API');

// --- Веб-сервис -------------------------------------------------------------------
eq(d.guessWebKind('nginx:alpine', ''), 'web', 'nginx');
eq(d.guessWebKind('grafana/grafana', ''), 'web', 'grafana');
eq(d.guessWebKind('custom', '0.0.0.0:8080->8080/tcp'), 'web', 'типовой веб-порт');
eq(d.guessWebKind('postgres:16', '0.0.0.0:5432->5432/tcp'), null, 'СУБД не веб');

const web = d.webPrefillFromInspect({
  Name: '/site', Config: { Image: 'nginx' },
  NetworkSettings: { Ports: { '80/tcp': [{ HostPort: '8088' }] } },
}, 'docker');
eq(web.prefill.url, 'http://127.0.0.1:8088', 'URL по опубликованному порту');

const webTls = d.webPrefillFromInspect({
  Name: 'tls', Config: { Image: 'custom' },
  NetworkSettings: { Ports: { '443/tcp': [{ HostPort: '8443' }] } },
}, 'docker');
eq(webTls.prefill.url, 'https://127.0.0.1:8443', '443 → https');

const webUnpublished = d.webPrefillFromInspect({ Name: 'u', Config: { Image: 'caddy' } }, 'docker');
eq(webUnpublished.prefill.url, null, 'без порта URL неизвестен');
ok(webUnpublished.published === false, 'не опубликован');

eq(d.webPrefillFromInspect({ Name: 'n', Config: { Image: 'redis:7' } }, 'docker'), null, 'redis не веб-сервис');

// --- Общая часть всех разборов: имя контейнера и признак «запущен» -----------------
// Один и тот же код повторён в каждой prefill-функции, поэтому проверяем его на каждой:
// иначе ошибка в четырёх копиях из пяти останется незамеченной.
const SHAPES = [
  { fn: 'dbPrefillFromInspect',      base: { Config: { Image: 'postgres:16', Env: ['POSTGRES_PASSWORD=p'] } } },
  { fn: 'rmqPrefillFromInspect',     base: { Config: { Image: 'rabbitmq:3' } } },
  { fn: 'kafkaPrefillFromInspect',   base: { Config: { Image: 'confluentinc/cp-kafka:7.5.0', Env: [] } } },
  { fn: 'storagePrefillFromInspect', base: { Config: { Image: 'minio/minio', Env: [] } } },
  { fn: 'webPrefillFromInspect',     base: { Config: { Image: 'nginx' } } },
];
for (const { fn, base } of SHAPES) {
  const slashed = d[fn]({ ...base, Name: '/svc-name', State: { Running: true } }, 'docker');
  eq(slashed.prefill.name, 'svc-name', `${fn}: ведущий слеш отброшен`);
  ok(slashed.running === true, `${fn}: Running=true`);
  eq(slashed.prefill.source, 'docker:svc-name', `${fn}: источник с движком и именем`);

  const noName = d[fn]({ ...base, Id: '0123456789abcdefff', State: { Running: false } }, 'podman');
  eq(noName.prefill.name, '0123456789ab', `${fn}: имя из 12 символов Id`);
  ok(noName.running === false, `${fn}: Running=false`);
  eq(noName.prefill.source, 'podman:0123456789ab', `${fn}: источник от имени по Id`);

  const noState = d[fn]({ ...base, Name: 'n' }, 'docker');
  ok(noState.running === false, `${fn}: без State контейнер считается остановленным`);

  const empty = d[fn]({ ...base }, 'docker');
  eq(empty.prefill.name, '', `${fn}: без Name и Id имя пустое`);
}

// --- Пути детекта, не покрытые основными сценариями ---------------------------------
ok(d.kafkaPrefillFromInspect({ Name: 'k', Config: { Image: 'custom', Env: ['KAFKA_CFG_NODE_ID=1'] } }, 'docker') !== null,
  'kafka по KAFKA_CFG_NODE_ID');
ok(d.kafkaPrefillFromInspect({ Name: 'k', Config: { Image: 'custom', Env: ['KAFKA_NODE_ID=1'] } }, 'docker') !== null,
  'kafka по KAFKA_NODE_ID');
ok(d.kafkaPrefillFromInspect({ Name: 'k', Config: { Image: 'custom', Env: [], ExposedPorts: { '9092/tcp': {} } } }, 'docker') !== null,
  'kafka по объявленному порту');
eq(d.kafkaPrefillFromInspect({ Name: 'k', Config: { Image: 'redis:7', Env: [] } }, 'docker'), null, 'redis не kafka');
eq(d.kafkaPrefillFromInspect(null, 'docker'), null, 'kafka: null не роняет');

const kafkaCfgAdv = d.kafkaPrefillFromInspect({
  Name: 'k', Config: { Image: 'bitnami/kafka:3.7', Env: ['KAFKA_CFG_ADVERTISED_LISTENERS=EXTERNAL://127.0.0.1:19092'] },
}, 'docker');
eq(kafkaCfgAdv.prefill.brokers, '127.0.0.1:19092', 'bitnami-переменная advertised-листенеров');

ok(d.storagePrefillFromInspect({ Name: 's', Config: { Image: 'custom', Env: ['MINIO_ROOT_USER=u'] } }, 'docker') !== null,
  'minio по MINIO_ROOT_USER на кастомном образе');
eq(d.storagePrefillFromInspect({ Name: 's', Config: { Image: 'nginx', Env: [] } }, 'docker'), null, 'nginx не хранилище');
eq(d.storagePrefillFromInspect(null, 'docker'), null, 'хранилище: null не роняет');
eq(d.rmqPrefillFromInspect(null, 'docker'), null, 'rabbitmq: null не роняет');
eq(d.webPrefillFromInspect(null, 'docker'), null, 'веб: null не роняет');

ok(d.rmqPrefillFromInspect({ Name: 'r', Config: { Image: 'custom', Env: ['RABBITMQ_VERSION=3.13'] } }, 'docker') !== null,
  'rabbitmq по RABBITMQ_VERSION');
ok(d.rmqPrefillFromInspect({ Name: 'r', Config: { Image: 'custom', Env: ['RABBITMQ_DEFAULT_USER=u'] } }, 'docker') !== null,
  'rabbitmq по RABBITMQ_DEFAULT_USER');

// Пустой пароль в env — валиден и не должен подменяться дефолтом guest.
const rmqEmptyPass = d.rmqPrefillFromInspect({
  Name: 'r', Config: { Image: 'rabbitmq:3', Env: ['RABBITMQ_DEFAULT_PASS='] },
}, 'docker');
eq(rmqEmptyPass.prefill.password, '', 'пустой RABBITMQ_DEFAULT_PASS остаётся пустым');

// env без «=» игнорируется, а значение со знаком «=» внутри не обрезается
const envEdge = d.dbPrefillFromInspect({
  Name: 'e', Config: { Image: 'postgres:16', Env: ['МУСОР', '=нет-имени', 'POSTGRES_PASSWORD=a=b=c'] },
}, 'docker');
eq(envEdge.prefill.password, 'a=b=c', 'знак = внутри значения сохраняется');

// Порт берётся из первой подходящей записи маппинга, нулевой/битый HostPort пропускается
const badPort = d.dbPrefillFromInspect({
  Name: 'b', Config: { Image: 'postgres:16', Env: ['POSTGRES_PASSWORD=p'] },
  NetworkSettings: { Ports: { '5432/tcp': [{ HostPort: '0' }, { HostPort: '5499' }] } },
}, 'docker');
eq(badPort.prefill.port, 5499, 'нулевой хост-порт пропускается');

const nullBinding = d.dbPrefillFromInspect({
  Name: 'nb', Config: { Image: 'postgres:16', Env: ['POSTGRES_PASSWORD=p'] },
  NetworkSettings: { Ports: { '5432/tcp': null } },
  HostConfig: { PortBindings: { '5432/tcp': [{ hostPort: '5477' }] } },
}, 'docker');
eq(nullBinding.prefill.port, 5477, 'HostPort в нижнем регистре (podman) тоже читается');

// Веб: приоритет портов — 80 раньше 8080, https только для 443
const webPriority = d.webPrefillFromInspect({
  Name: 'w', Config: { Image: 'custom' },
  NetworkSettings: { Ports: { '8080/tcp': [{ HostPort: '18080' }], '80/tcp': [{ HostPort: '18081' }] } },
}, 'docker');
eq(webPriority.prefill.url, 'http://127.0.0.1:18081', 'порт 80 приоритетнее 8080');

eq(d.guessWebKind('custom', '0.0.0.0:5601->5601/tcp'), 'web', 'kibana-порт считается веб-портом');
eq(d.guessWebKind('custom', '0.0.0.0:9092->9092/tcp'), null, 'kafka-порт не веб');
eq(d.guessMqKind(null, null), null, 'guessMqKind: null не роняет');
eq(d.guessWebKind(null, null), null, 'guessWebKind: null не роняет');
eq(d.guessStorageKind(null), null, 'guessStorageKind: null не роняет');

console.log(`✓ dbdetect: ${passed} проверок пройдено`);
