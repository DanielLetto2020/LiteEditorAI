// Детект сервисов в docker/podman-контейнере для связок «Контейнеры» → модули.
// Чистая логика без зависимостей: guessDbKind()/guessMqKind() — дешёвые эвристики для списка
// (образ/порты), dbPrefillFromInspect()/rmqPrefillFromInspect() — полный разбор `inspect`
// (env → креды, ports → хост-порт). СУБД — типы lib/db.js (postgres, mysql/mariadb);
// брокер — RabbitMQ для модуля lib/rmq.js (management HTTP API).

const DB_CONTAINER_PORT = { postgres: 5432, mysql: 3306 };

// Эвристика по имени образа + строке портов из списка: docker «0.0.0.0:5434->5432/tcp»,
// podman-ветка cListContainers строит «5434:5432». proxysql/percona-toolkit — не серверы БД.
function guessDbKind(image, portsStr) {
  const img = String(image || '').toLowerCase();
  if (/postgres|postgis|pgvector|timescaledb/.test(img)) return 'postgres';
  if (/mysql|mariadb|percona/.test(img) && !/proxysql|percona-toolkit/.test(img)) return 'mysql';
  const p = String(portsStr || '');
  if (/(?:->|:)5432(?:\/tcp)?(?:,|\s|$)/.test(p)) return 'postgres';
  if (/(?:->|:)3306(?:\/tcp)?(?:,|\s|$)/.test(p)) return 'mysql';
  return null;
}

function envToMap(envArr) {
  const m = {};
  for (const s of (Array.isArray(envArr) ? envArr : [])) {
    const i = String(s).indexOf('=');
    if (i > 0) m[String(s).slice(0, i)] = String(s).slice(i + 1);
  }
  return m;
}

// Хост-порт для контейнерного порта БД. У остановленного контейнера NetworkSettings.Ports
// бывает пуст — фолбэк на настроенный маппинг HostConfig.PortBindings (тот же формат).
function hostPortFor(info, containerPort) {
  const key = containerPort + '/tcp';
  for (const src of [info.NetworkSettings && info.NetworkSettings.Ports, info.HostConfig && info.HostConfig.PortBindings]) {
    const arr = src && src[key];
    if (!Array.isArray(arr)) continue;
    for (const b of arr) { const hp = parseInt(b && (b.HostPort || b.hostPort), 10); if (hp > 0) return hp; }
  }
  return null;
}

// env → { user, password, database, passwordUnknown } по семействам образов:
// официальные postgres/mysql/mariadb + bitnami (POSTGRESQL_*). password === '' — валидный
// пустой пароль (trust/ALLOW_EMPTY); passwordUnknown — секрет вне env (…_FILE / RANDOM_…).
function credsFromEnv(kind, env) {
  if (kind === 'postgres') {
    const user = env.POSTGRES_USER || env.POSTGRESQL_USERNAME || 'postgres';
    let password = null, passwordUnknown = false;
    if (env.POSTGRES_PASSWORD != null) password = env.POSTGRES_PASSWORD;
    else if (env.POSTGRESQL_PASSWORD != null) password = env.POSTGRESQL_PASSWORD;
    else if (String(env.POSTGRES_HOST_AUTH_METHOD || '').includes('trust')) password = '';
    else passwordUnknown = true; // POSTGRES_PASSWORD_FILE / docker secrets
    return { user, password, database: env.POSTGRES_DB || env.POSTGRESQL_DATABASE || user, passwordUnknown };
  }
  // mysql / mariadb: непривилегированный юзер, если задан, иначе root
  const appUser = env.MYSQL_USER || env.MARIADB_USER;
  let user, password = null, passwordUnknown = false;
  if (appUser) {
    user = appUser;
    if (env.MYSQL_PASSWORD != null) password = env.MYSQL_PASSWORD;
    else if (env.MARIADB_PASSWORD != null) password = env.MARIADB_PASSWORD;
    else passwordUnknown = true;
  } else {
    user = 'root';
    if (env.MYSQL_RANDOM_ROOT_PASSWORD || env.MARIADB_RANDOM_ROOT_PASSWORD) passwordUnknown = true;
    else if (env.MYSQL_ROOT_PASSWORD != null) password = env.MYSQL_ROOT_PASSWORD;
    else if (env.MARIADB_ROOT_PASSWORD != null) password = env.MARIADB_ROOT_PASSWORD;
    else if (env.MYSQL_ALLOW_EMPTY_PASSWORD || env.MARIADB_ALLOW_EMPTY_ROOT_PASSWORD) password = '';
    else passwordUnknown = true;
  }
  return { user, password, database: env.MYSQL_DATABASE || env.MARIADB_DATABASE || '', passwordUnknown };
}

// Полный разбор одного объекта `docker/podman inspect` → заготовка подключения для модуля БД.
// null — БД не распознана. prefill.port: хост-порт, а при его отсутствии контейнерный
// (published:false скажет UI, что снаружи не достучаться).
function dbPrefillFromInspect(info, engine) {
  if (!info || typeof info !== 'object') return null;
  const cfg = info.Config || {};
  const env = envToMap(cfg.Env);
  let kind = guessDbKind(cfg.Image || info.ImageName || '', '');
  if (!kind) { // кастомный образ: по характерным env, затем по объявленным портам
    if (env.POSTGRES_PASSWORD != null || env.POSTGRES_USER || env.POSTGRESQL_PASSWORD != null) kind = 'postgres';
    else if (env.MYSQL_ROOT_PASSWORD != null || env.MYSQL_USER || env.MARIADB_ROOT_PASSWORD != null || env.MARIADB_USER) kind = 'mysql';
    else {
      const exposed = Object.keys(cfg.ExposedPorts || {});
      if (exposed.includes('5432/tcp')) kind = 'postgres';
      else if (exposed.includes('3306/tcp')) kind = 'mysql';
    }
  }
  if (!kind) return null;
  const { user, password, database, passwordUnknown } = credsFromEnv(kind, env);
  const name = String(info.Name || '').replace(/^\//, '') || String(info.Id || '').slice(0, 12);
  const hostPort = hostPortFor(info, DB_CONTAINER_PORT[kind]);
  return {
    kind,
    published: hostPort != null,
    passwordUnknown,
    running: !!(info.State && info.State.Running),
    prefill: {
      name, type: kind, host: '127.0.0.1', port: hostPort || DB_CONTAINER_PORT[kind],
      user, password: passwordUnknown ? null : password, database: database || '',
      category: 'Контейнеры', source: engine + ':' + name,
    },
  };
}

// ---------------------------------------------------------------- RabbitMQ
const RMQ_AMQP_PORT = 5672, RMQ_MGMT_PORT = 15672;

// Эвристика для списка: RabbitMQ — образ rabbitmq или проброшенный 5672/15672;
// Kafka — образ kafka/redpanda или проброшенный 9092/29092/9094.
function guessMqKind(image, portsStr) {
  const img = String(image || '').toLowerCase();
  if (/rabbitmq/.test(img)) return 'rabbitmq';
  if (/kafka|redpanda/.test(img)) return 'kafka';
  const p = String(portsStr || '');
  if (/(?:->|:)5672(?:\/tcp)?(?:,|\s|$)/.test(p) || /(?:->|:)15672(?:\/tcp)?(?:,|\s|$)/.test(p)) return 'rabbitmq';
  if (/(?:->|:)(?:9092|29092|9094)(?:\/tcp)?(?:,|\s|$)/.test(p)) return 'kafka';
  return null;
}

// Полный разбор inspect → заготовка профиля для модуля «RabbitMQ». Креды из env
// (RABBITMQ_DEFAULT_*), дефолт guest/guest — он валиден только с localhost, а мы как раз
// ходим на 127.0.0.1. МVP работает через management HTTP API → published требует порт 15672
// (образ без management-плагина его не объявляет).
function rmqPrefillFromInspect(info, engine) {
  if (!info || typeof info !== 'object') return null;
  const cfg = info.Config || {};
  const env = envToMap(cfg.Env);
  let is = /rabbitmq/i.test(cfg.Image || info.ImageName || '') || env.RABBITMQ_VERSION != null || env.RABBITMQ_DEFAULT_USER != null;
  if (!is) {
    const exposed = Object.keys(cfg.ExposedPorts || {});
    is = exposed.includes('5672/tcp') && exposed.includes('15672/tcp');
  }
  if (!is) return null;
  const name = String(info.Name || '').replace(/^\//, '') || String(info.Id || '').slice(0, 12);
  const mgmtPort = hostPortFor(info, RMQ_MGMT_PORT);
  const amqpPort = hostPortFor(info, RMQ_AMQP_PORT);
  return {
    kind: 'rabbitmq',
    published: mgmtPort != null,          // для management API
    amqpPublished: amqpPort != null,      // пригодится live-tail (v2)
    running: !!(info.State && info.State.Running),
    prefill: {
      name, host: '127.0.0.1', port: mgmtPort || RMQ_MGMT_PORT, amqpPort: amqpPort || RMQ_AMQP_PORT,
      user: env.RABBITMQ_DEFAULT_USER || 'guest',
      password: env.RABBITMQ_DEFAULT_PASS != null ? env.RABBITMQ_DEFAULT_PASS : 'guest',
      vhost: env.RABBITMQ_DEFAULT_VHOST || '/',
      category: 'Контейнеры', source: engine + ':' + name,
    },
  };
}

// ---------------------------------------------------------------- Kafka
// Полный разбор inspect → заготовка профиля для модуля «Kafka». Клиентский порт — эвристика:
// сперва localhost-адрес из advertised.listeners (это порт, на который реально отзовётся брокер
// при подключении с хоста), затем типовые published-порты (29092/9094 — «внешние» листенеры
// confluent/bitnami, 9092 — стандартный). Если advertised указывает на внутреннее имя сети —
// коннект не пройдёт, автопроверка в модуле покажет префилл-форму.
function kafkaPrefillFromInspect(info, engine) {
  if (!info || typeof info !== 'object') return null;
  const cfg = info.Config || {};
  const env = envToMap(cfg.Env);
  const adv = env.KAFKA_ADVERTISED_LISTENERS || env.KAFKA_CFG_ADVERTISED_LISTENERS || '';
  let is = /kafka|redpanda/i.test(cfg.Image || info.ImageName || '') || !!adv || env.KAFKA_CFG_NODE_ID != null || env.KAFKA_NODE_ID != null;
  if (!is) {
    const exposed = Object.keys(cfg.ExposedPorts || {});
    is = exposed.includes('9092/tcp');
  }
  if (!is) return null;
  let advPort = null;
  const m = adv.match(/\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i);
  if (m) advPort = parseInt(m[1], 10) || null;
  const mapped = hostPortFor(info, 29092) || hostPortFor(info, 9094) || hostPortFor(info, 9092) || hostPortFor(info, 19092);
  const port = advPort || mapped || 9092;
  const name = String(info.Name || '').replace(/^\//, '') || String(info.Id || '').slice(0, 12);
  return {
    kind: 'kafka',
    published: advPort != null || mapped != null,
    running: !!(info.State && info.State.Running),
    prefill: {
      name, brokers: '127.0.0.1:' + port,
      category: 'Контейнеры', source: engine + ':' + name,
    },
  };
}

// ---------------------------------------------------------------- Веб-сервис (→ «Мониторинг сайтов»)
// Контейнерные порты, которые считаем веб-интерфейсом (по приоритету: классика → dev-серверы → UI-панели).
const WEB_PORTS = [80, 443, 8080, 3000, 8000, 5173, 4200, 8081, 8888, 5601, 9000];

// Эвристика для списка: образ явно веб-серверный ЛИБО проброшен типовой веб-порт.
// СУБД/брокеры сюда не попадают (их порты не из WEB_PORTS), пересечения гасит UI.
function guessWebKind(image, portsStr) {
  const img = String(image || '').toLowerCase();
  if (/nginx|caddy|traefik|httpd|wordpress|ghost|grafana|kibana|portainer|keycloak|nextcloud|swagger/.test(img)) return 'web';
  const p = String(portsStr || '');
  for (const port of WEB_PORTS)
    if (new RegExp('(?:->|:)' + port + '(?:\\/tcp)?(?:,|\\s|$)').test(p)) return 'web';
  return null;
}

// Полный разбор inspect → заготовка записи для «Мониторинга сайтов»: URL по первому
// опубликованному веб-порту (80 → http, 443 → https, остальные → http://127.0.0.1:hostPort).
function webPrefillFromInspect(info, engine) {
  if (!info || typeof info !== 'object') return null;
  const cfg = info.Config || {};
  let containerPort = null, hostPort = null;
  for (const port of WEB_PORTS) {
    const hp = hostPortFor(info, port);
    if (hp != null) { containerPort = port; hostPort = hp; break; }
  }
  if (hostPort == null && !guessWebKind(cfg.Image || info.ImageName || '', '')) return null;
  const name = String(info.Name || '').replace(/^\//, '') || String(info.Id || '').slice(0, 12);
  const scheme = containerPort === 443 ? 'https' : 'http';
  return {
    kind: 'web',
    published: hostPort != null,
    running: !!(info.State && info.State.Running),
    prefill: {
      name,
      url: hostPort != null ? scheme + '://127.0.0.1:' + hostPort : null,
      source: engine + ':' + name,
    },
  };
}

module.exports = { guessDbKind, dbPrefillFromInspect, guessMqKind, rmqPrefillFromInspect, kafkaPrefillFromInspect, guessWebKind, webPrefillFromInspect };
