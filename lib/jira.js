// Бэкенд модуля «Jira»: мульти-аккаунт + REST API v2 (Cloud и Server/Data Center одним кодом).
// Без зависимостей — HTTP через глобальный fetch (Node 18+). Секреты шифрует safeStorage
// (схема enc/dec — как lib/db.js / lib/rmq.js); токен НИКОГДА не уходит в рендерер: наружу
// отдаётся только флаг hasToken. Соединение stateless — каждый вызов это один HTTP-запрос.
//
// Почему v2, а не v3: в v3 описания и комментарии приходят как ADF (дерево JSON) и требуют
// конвертера в обе стороны; v2 отдаёт ту же самую wiki-разметку строкой и живёт на обоих
// развёртываниях. Один код — обе Jira.
//
// Универсальность (модуль НЕ знает схему конкретной Jira — он её обнаруживает):
//   - статусы/воркфлоу  → /issue/{key}/transitions спрашивает сервер, что доступно сейчас;
//   - кастомные поля    → /field читается при подключении, рендер по schema.type;
//   - канбан-колонки    → по status.statusCategory (три категории есть в любой инсталляции);
//   - Agile-модуль      → probe /rest/agile/1.0/board, 404 = досок нет, вкладку прячем;
//   - Cloud vs DC       → пагинация: курсор nextPageToken (Cloud) или startAt (DC), фолбэк по факту.
//
// main.js: registerJiraIpc({ ipcMain, safeStorage, getAccounts, setAccounts, storeDir }).

const fs = require('fs');
const path = require('path');

let _safe = null, _get = null, _set = null, _dir = '';

const TIMEOUT_MS = 20000;
const MAX_PAGES = 5;          // потолок обхода выдачи JQL (5 × 100 = 500 задач)
const PAGE = 100;

// Поля, которых достаточно для списка. Тянуть всё — мегабайты на сотню задач.
const LIST_FIELDS = 'summary,status,issuetype,priority,project,assignee,reporter,created,updated,duedate,labels,parent';

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
function loadAccs() { const a = _get(); return Array.isArray(a) ? a : []; }
function saveAccs(a) { _set(a); }
// Наружу (рендерер, отчёты, логи) уходит запись БЕЗ токена — только признак, что он задан.
function publicAcc(a) { const { tokenEnc, ...rest } = a; return { ...rest, hasToken: !!tokenEnc }; }
function publicList() { return loadAccs().map(publicAcc); }
function accById(id) {
  const a = loadAccs().find((x) => x.id === id);
  if (!a) throw new Error('Аккаунт Jira не найден');
  return a;
}

// Режим пагинации, распознанный по факту первого запроса: 'jql' (Cloud, курсор) | 'legacy' (DC, startAt).
const searchMode = new Map();

// ---------------------------------------------------------------- HTTP
function baseOf(a) { return String(a.host || '').replace(/\/+$/, ''); }

// Приведение адреса к корню REST API. Из адресной строки браузера обычно копируется ссылка на
// саму задачу или дашборд — отрезаем известные хвосты приложения, но НЕ трогаем контекстный путь
// (у Jira Server/DC она часто живёт на /jira, и он — часть базового адреса).
function normalizeHost(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  s = s.split('#')[0].split('?')[0];
  s = s.replace(/\/(rest|browse|secure|plugins|projects|issues|jira\/software|login\.jsp)(\/.*)?$/i, '');
  return s.replace(/\/+$/, '');
}

function authHeader(a) {
  const token = dec(a.tokenEnc);
  if (!token) throw new Error('У аккаунта не задан токен — откройте «Аккаунты» и введите его');
  // pat  — Server/DC: Personal Access Token, работает мимо SSO (Keycloak и т.п.);
  // basic — Cloud: e-mail + API-токен.
  if (a.mode === 'pat') return 'Bearer ' + token;
  return 'Basic ' + Buffer.from((a.login || '') + ':' + token).toString('base64');
}

// Разбор ответа с расчётом на корпоративные инсталляции: SSO-прокси на 401 отдаёт не JSON,
// а HTML страницы входа (после редиректа) — без этой ветки пользователь получил бы
// «Unexpected token < in JSON» вместо «войдите заново».
async function readResponse(a, res, url) {
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();

  if (!ct.includes('json')) {
    const host = (() => { try { return new URL(res.url || url).host; } catch (_) { return ''; } })();
    const ourHost = (() => { try { return new URL(baseOf(a)).host; } catch (_) { return ''; } })();
    if (host && ourHost && host !== ourHost)
      throw new Error('Запрос увели на ' + host + ' — сессия SSO не принимается REST API. Нужен Personal Access Token (режим PAT).');
    // 404 без JSON — это НЕ про авторизацию: по такому пути REST API просто нет. Самая частая
    // причина — базовый адрес: у Jira Server/DC она нередко висит на контекстном пути (/jira).
    if (res.status === 404)
      throw new Error('По адресу ' + baseOf(a) + ' нет REST API Jira (404). Проверьте базовый адрес: у Jira Server/DC часто есть контекстный путь — попробуйте ' + baseOf(a) + '/jira');
    throw new Error('Сервер ответил не JSON (HTTP ' + res.status + ') — обычно это страница входа SSO. Проверьте токен и режим авторизации.');
  }

  let data;
  try { data = text ? JSON.parse(text) : null; } catch (e) { throw new Error('Некорректный JSON в ответе (HTTP ' + res.status + ')', { cause: e }); }

  if (res.ok) return data;

  // Jira кладёт причину отказа в заголовок — это единственный способ отличить капчу от неверного токена.
  const denied = res.headers.get('x-authentication-denied-reason') || '';
  if (denied.includes('CAPTCHA'))
    throw new Error('Jira требует пройти капчу: войдите в неё браузером, затем повторите');
  if (res.status === 401) throw new Error('Доступ запрещён (401) — токен неверен, отозван или истёк');
  if (res.status === 403) throw new Error('Недостаточно прав (403)' + (denied ? ': ' + denied : ''));
  if (res.status === 429) {
    const ra = res.headers.get('retry-after');
    throw new Error('Слишком много запросов (429)' + (ra ? ' — повторите через ' + ra + ' с' : ''));
  }
  const msgs = data && (Array.isArray(data.errorMessages) ? data.errorMessages : []);
  const errs = data && data.errors && typeof data.errors === 'object' ? Object.values(data.errors) : [];
  const reason = [...(msgs || []), ...errs].filter(Boolean).join('; ');
  throw new Error('HTTP ' + res.status + (reason ? ': ' + reason : ''));
}

async function api(a, method, apiPath, body, opts = {}) {
  const base = baseOf(a);
  if (!base) throw new Error('У аккаунта не задан адрес Jira');
  const url = base + apiPath;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: method || 'GET', signal: ctl.signal,
      headers: {
        // opts.anon — проба адреса без авторизации: на многих Jira DC serverInfo открыт анонимно,
        // а сам факт JSON-ответа (пусть даже 401) доказывает, что базовый адрес верный.
        ...(opts.anon ? {} : { Authorization: authHeader(a) }),
        Accept: 'application/json',
        // Без этого заголовка Jira отбивает POST как XSRF, если авторизация прошла по куке.
        'X-Atlassian-Token': 'no-check',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Таймаут запроса (' + (TIMEOUT_MS / 1000) + ' с) — Jira не отвечает', { cause: e });
    // Корпоративная Jira обычно за VPN: без него это именно сетевая ошибка, а не проблема токена.
    throw new Error('Нет соединения с ' + base + ' (' + String(e.message || e) + '). Если Jira за VPN — проверьте, что он поднят.', { cause: e });
  } finally { clearTimeout(t); }
  return readResponse(a, res, url);
}

const q = (o) => Object.entries(o)
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
  .join('&');

// ---------------------------------------------------------------- слим-маппинг задач
// В рендерер уходит только то, что рисуется: сырой issue от Jira — десятки килобайт на штуку.
function slimIssue(a, it, extra = {}) {
  const f = it.fields || {};
  const st = f.status || {};
  const sprints = extra.sprintId ? parseSprints(f[extra.sprintId]) : [];
  return {
    // kind — «рабочий» тип из поля инсталляции («Разработка», «Проверка CR»).
    // Системный issuetype остаётся в type: он нужен для подсказки и как запасной вариант.
    kind: pickKind(f, extra),
    sprints: sprints.map((s) => s.name),
    // Текущий спринт — тот, что в состоянии active; их может быть несколько (параллельные доски).
    activeSprints: sprints.filter((s) => s.state === 'active').map((s) => s.name),
    accId: a.id,
    key: it.key,
    url: baseOf(a) + '/browse/' + it.key,
    summary: f.summary || '',
    status: st.name || '',
    // Категория — единственный статус-признак, одинаковый во всех инсталляциях:
    // 'new' | 'indeterminate' | 'done'. По ней строятся колонки, а не по именам статусов.
    statusCat: (st.statusCategory && st.statusCategory.key) || '',
    type: (f.issuetype && f.issuetype.name) || '',
    subtask: !!(f.issuetype && f.issuetype.subtask),
    priority: (f.priority && f.priority.name) || '',
    project: (f.project && f.project.key) || '',
    projectName: (f.project && f.project.name) || '',
    assignee: (f.assignee && f.assignee.displayName) || '',
    reporter: (f.reporter && f.reporter.displayName) || '',
    created: f.created || '',
    updated: f.updated || '',
    due: f.duedate || '',
    labels: Array.isArray(f.labels) ? f.labels : [],
    parent: (f.parent && f.parent.key) || '',
  };
}

// ---------------------------------------------------------------- JQL с двумя пагинациями
// Cloud выпилил /search в мае 2025 и требует /search/jql с курсором nextPageToken;
// Server/DC знает только /search со startAt. Версию не нюхаем — пробуем и запоминаем,
// что сработало: инсталляции бывают промежуточные, а поведение важнее номера версии.
/** @param {{ fields?: string, startAt?: number, token?: string|null, max?: number }} p */
async function searchPage(a, jql, p) {
  const { fields, startAt, token, max } = p;
  const mode = searchMode.get(a.id);
  const limit = max || PAGE;

  if (mode !== 'legacy') {
    try {
      const r = await api(a, 'GET', '/rest/api/2/search/jql?' + q({
        jql, fields: fields || LIST_FIELDS, maxResults: limit, nextPageToken: token,
      }));
      searchMode.set(a.id, 'jql');
      return { issues: r.issues || [], next: r.nextPageToken || null, total: r.total ?? null };
    } catch (e) {
      // 404/400 на /search/jql = инсталляция его не знает → уходим на классический /search.
      if (mode === 'jql') throw e;
      const m = String(e.message || e);
      if (!/HTTP (404|400|405)/.test(m)) throw e;
    }
  }

  const r = await api(a, 'GET', '/rest/api/2/search?' + q({
    jql, fields: fields || LIST_FIELDS, maxResults: limit, startAt: startAt || 0,
  }));
  searchMode.set(a.id, 'legacy');
  const got = (startAt || 0) + (r.issues || []).length;
  return { issues: r.issues || [], next: null, nextStart: got < (r.total || 0) ? got : null, total: r.total ?? null };
}

// Обход выдачи до потолка MAX_PAGES. Возвращает { issues, total, truncated } — truncated
// говорит UI, что показана не вся выдача (молчаливое усечение выглядело бы как «это всё»).
/** @param {{ fields?: string, limit?: number }} [opts] */
async function searchAll(a, jql, opts = {}) {
  const { fields, limit } = opts;
  const cap = Math.min(limit || MAX_PAGES * PAGE, MAX_PAGES * PAGE);
  const out = [];
  let token = null, start = 0, total = null, pages = 0;
  for (;;) {
    const r = await searchPage(a, jql, { fields, token, startAt: start });
    out.push(...r.issues);
    total = r.total ?? total;
    pages++;
    if (out.length >= cap) return { issues: out.slice(0, cap), total, truncated: true };
    if (r.next) { token = r.next; continue; }
    if (r.nextStart != null) { start = r.nextStart; continue; }
    if (pages >= MAX_PAGES) return { issues: out, total, truncated: (total || 0) > out.length };
    return { issues: out, total: total ?? out.length, truncated: false };
  }
}

// ---------------------------------------------------------------- пресеты «моё»
// currentUser() снимает разницу между Cloud (accountId) и DC (username) — в JQL это одно и то же.
// «Не завершено» проверяется ДВУМЯ условиями, потому что одного мало:
//   statusCategory != Done — ловит статусы, отнесённые к категории «Готово»;
//   resolution = EMPTY     — ловит закрытые задачи, чей статус остался в другой категории
//                            (частый случай в кастомных воркфлоу: «Закрыто» настроено как «в работе»).
// Оба условия системные и есть в любой инсталляции, так что имена статусов знать не требуется.
const NOT_DONE = 'statusCategory != Done AND resolution = EMPTY';
const PRESETS = {
  open: 'assignee = currentUser() AND ' + NOT_DONE + ' ORDER BY updated DESC',
  all: 'assignee = currentUser() ORDER BY updated DESC',
  reported: 'reporter = currentUser() AND ' + NOT_DONE + ' ORDER BY updated DESC',
  watched: 'watcher = currentUser() AND ' + NOT_DONE + ' ORDER BY updated DESC',
  past: 'assignee WAS currentUser() AND assignee != currentUser() ORDER BY updated DESC',
  recent: 'assignee = currentUser() AND ' + NOT_DONE + ' AND updated >= -14d ORDER BY updated DESC',
};
function jqlFor(preset, custom) {
  if (preset === 'custom') {
    const s = String(custom || '').trim();
    if (!s) throw new Error('Пустой JQL');
    return s;
  }
  return PRESETS[preset] || PRESETS.open;
}

// ---------------------------------------------------------------- разведка структуры
// Что здесь принципиально: собирается ТОЛЬКО структура (проекты, статусы, поля, доски) и
// счётчики. Тексты задач не выгружаются, пока withTexts не запрошен явно — отчёт уезжает
// человеку/агенту, и содержимое рабочих задач в нём оказываться не должно по умолчанию.
/** @param {{ withTexts?: boolean }} [opts] */
async function recon(a, opts = {}) {
  const { withTexts } = opts;
  const soft = async (fn, fallback) => { try { return await fn(); } catch (_) { return fallback; } };

  const [info, me] = await Promise.all([
    soft(() => api(a, 'GET', '/rest/api/2/serverInfo'), null),
    api(a, 'GET', '/rest/api/2/myself'), // без этого разведка бессмысленна — пусть падает
  ]);

  // Cloud отдаёт проекты только постранично через /project/search, DC — списком через /project.
  const projects = await soft(async () => {
    const r = await api(a, 'GET', '/rest/api/2/project/search?' + q({ maxResults: 200 }));
    return r.values || [];
  }, null) || await soft(() => api(a, 'GET', '/rest/api/2/project'), []);

  const [statuses, types, prios, fields, filters] = await Promise.all([
    soft(() => api(a, 'GET', '/rest/api/2/status'), []),
    soft(() => api(a, 'GET', '/rest/api/2/issuetype'), []),
    soft(() => api(a, 'GET', '/rest/api/2/priority'), []),
    soft(() => api(a, 'GET', '/rest/api/2/field'), []),
    soft(() => api(a, 'GET', '/rest/api/2/filter/favourite'), []),
  ]);

  // Agile API есть не везде (Core / Service Management его не ставят) — 404 здесь нормален.
  const boards = await soft(async () => {
    const r = await api(a, 'GET', '/rest/agile/1.0/board?' + q({ maxResults: 100 }));
    return r.values || [];
  }, null);

  // Один проход по своим задачам вместо запроса на каждый проект: даёт и раскладку по
  // проектам, и раскладку по статусам разом.
  const mine = await searchAll(a, PRESETS.all, { fields: 'project,status,issuetype,updated' + (withTexts ? ',summary' : ''), limit: 500 });
  const byProject = new Map();
  const byStatus = new Map();
  const byCat = { new: 0, indeterminate: 0, done: 0 };
  for (const it of mine.issues) {
    const f = it.fields || {};
    const pk = (f.project && f.project.key) || '—';
    const pv = byProject.get(pk) || { key: pk, name: (f.project && f.project.name) || '', total: 0, open: 0, samples: [] };
    pv.total++;
    const cat = (f.status && f.status.statusCategory && f.status.statusCategory.key) || '';
    if (cat !== 'done') pv.open++;
    if (withTexts && pv.samples.length < 3) pv.samples.push(it.key + ' — ' + ((f.summary || '').slice(0, 120)));
    byProject.set(pk, pv);
    const sn = (f.status && f.status.name) || '—';
    byStatus.set(sn, (byStatus.get(sn) || 0) + 1);
    if (cat in byCat) byCat[cat]++;
  }

  const custom = (Array.isArray(fields) ? fields : []).filter((f) => f.custom);
  return {
    generatedAt: new Date().toISOString(),
    account: { id: a.id, name: a.name, mode: a.mode },  // host/login/токен в отчёт не кладём
    server: info ? {
      version: info.version || '', deploymentType: info.deploymentType || '',
      buildNumber: info.buildNumber || null, serverTitle: info.serverTitle || '',
    } : null,
    me: { displayName: me.displayName || '', accountId: me.accountId || me.key || me.name || '', active: me.active !== false },
    searchMode: searchMode.get(a.id) || '',
    projects: (Array.isArray(projects) ? projects : []).map((p) => ({
      key: p.key, name: p.name, type: p.projectTypeKey || '', style: p.style || '',
    })),
    statuses: (Array.isArray(statuses) ? statuses : []).map((s) => ({
      name: s.name, category: (s.statusCategory && s.statusCategory.key) || '',
    })),
    issueTypes: (Array.isArray(types) ? types : []).map((t) => ({ name: t.name, subtask: !!t.subtask })),
    priorities: (Array.isArray(prios) ? prios : []).map((p) => p.name),
    fields: {
      total: Array.isArray(fields) ? fields.length : 0,
      custom: custom.map((f) => ({ id: f.id, name: f.name, type: (f.schema && f.schema.type) || '', custom: (f.schema && f.schema.custom) || '' })),
    },
    boards: boards === null ? null : boards.map((b) => ({ id: b.id, name: b.name, type: b.type || '', project: (b.location && b.location.projectKey) || '' }),),
    favouriteFilters: (Array.isArray(filters) ? filters : []).map((f) => ({ id: f.id, name: f.name, jql: f.jql || '' })),
    mine: {
      scanned: mine.issues.length, total: mine.total, truncated: mine.truncated,
      byCategory: byCat,
      byProject: [...byProject.values()].sort((x, y) => y.total - x.total),
      byStatus: [...byStatus.entries()].map(([name, count]) => ({ name, count })).sort((x, y) => y.count - x.count),
    },
    withTexts: !!withTexts,
  };
}

// ---------------------------------------------------------------- поля инсталляции
// Имена кастомных полей («Ранг задачи», «В группу разработки», Sprint) у каждой компании свои и
// живут под безликими customfield_NNNNN. Карту id→имя спрашиваем у самой Jira и держим в памяти:
// хардкодить чужие идентификаторы нельзя — в соседней инсталляции они означают другое.
const fieldInfo = new Map();   // accId -> { names, sprintId, typeFieldId }

// Во многих инсталляциях реальная классификация работы живёт НЕ в системном issuetype
// («Задача», Story), а в кастомном поле вроде «Тип задачи» со значениями «Разработка»,
// «Проверка CR». Ищем такое поле по имени — вариантов немного, а привязка к id невозможна:
// он свой в каждой Jira. Пользователь может задать поле явно (account.typeField).
const TYPE_FIELD_HINTS = ['тип задачи', 'тип работ', 'тип работы', 'issue type', 'work type', 'task type', 'тип'];

async function fieldsInfo(a) {
  const have = fieldInfo.get(a.id);
  if (have) return have;
  const names = new Map();
  let sprintId = '';
  const typeCandidates = [];
  try {
    for (const f of await api(a, 'GET', '/rest/api/2/field')) {
      if (!f || !f.id) continue;
      names.set(f.id, f.name || f.id);
      // Поле спринта находим по типу (gh-sprint — его заводит сам Jira Software), а не по имени.
      if (!sprintId && f.schema && String(f.schema.custom || '').includes('gh-sprint')) sprintId = f.id;
      // Кандидат на «поле типа» ищется по ИМЕНИ и среди любых полей: в части инсталляций
      // schema у поля не приходит вовсе, и требование f.schema.custom его отсекало.
      if (f.id === 'issuetype') continue;   // системный тип берётся отдельно
      const nm = String(f.name || '').trim().toLowerCase();
      const exact = TYPE_FIELD_HINTS.indexOf(nm);
      if (exact >= 0) typeCandidates.push({ id: f.id, rank: exact });
      else if (nm.includes('тип задачи') || nm.includes('тип работ')) typeCandidates.push({ id: f.id, rank: 50 });
    }
  } catch (_) { /* без карты покажем сырые id — это лучше, чем не показать поле совсем */ }
  typeCandidates.sort((x, y) => x.rank - y.rank);
  const typeFieldId = a.typeField || (typeCandidates[0] && typeCandidates[0].id) || '';
  // Все подходящие по имени поля, а не только лучшее: в задаче заполнено может быть любое из них,
  // а стоят они копейки — это несколько лишних id в параметре fields.
  const typeIds = typeCandidates.map((c) => c.id);
  const info = { names, sprintId, typeFieldId, typeIds };
  fieldInfo.set(a.id, info);
  return info;
}

// Спринты приходят двумя формами: объектами (Cloud) и строками-дампами Java-объекта (Server/DC).
// Нужны имя и состояние — по состоянию определяется текущий спринт.
function parseSprints(v) {
  const arr = Array.isArray(v) ? v : (v ? [v] : []);
  return arr.map((s) => {
    if (s && typeof s === 'object') return { name: String(s.name || ''), state: String(s.state || '').toLowerCase() };
    const str = String(s);
    const name = (str.match(/[[,]name=([^,\]]+)/) || [])[1] || '';
    const state = ((str.match(/[[,]state=([^,\]]+)/) || [])[1] || '').toLowerCase();
    return { name: name.trim(), state };
  }).filter((x) => x.name);
}

// Поля, которые уже показаны отдельными блоками карточки либо не несут смысла в интерфейсе.
const SKIP_FIELDS = new Set([
  'summary', 'status', 'issuetype', 'priority', 'project', 'assignee', 'reporter', 'creator',
  'created', 'updated', 'lastViewed', 'duedate', 'labels', 'parent', 'description', 'comment',
  'subtasks', 'issuelinks', 'timetracking', 'components', 'fixVersions', 'attachment', 'worklog',
  'watches', 'votes', 'progress', 'aggregateprogress', 'workratio', 'thumbnail', 'resolutiondate',
  'timespent', 'timeestimate', 'timeoriginalestimate', 'aggregatetimespent',
  'aggregatetimeestimate', 'aggregatetimeoriginalestimate', 'security', 'environment',
]);

// Значение поля к человеческому виду. Jira отдаёт их десятком форм; разбираем известные,
// незнакомые пропускаем — сырой JSON в карточке хуже, чем его отсутствие.
function fieldText(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') {
    // Sprint в Server/DC приходит строкой-дампом Java-объекта: вытаскиваем имя спринта.
    const m = v.match(/\[.*?name=([^,\]]+)/);
    if (m) return m[1].trim();
    // Остальные строковые значения могут нести разметку ({color:#…}Разработка{color}, HTML) —
    // в бейдже и фильтре нужен чистый текст, а не теги.
    return wikiToText(v);
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(fieldText).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    if (v.displayName) return v.displayName;
    if (v.name && v.key && v.fields) return v.key + ' · ' + (v.fields.summary || '');  // ссылка на задачу
    if (v.value) return wikiToText(String(v.value)) + (v.child ? ' / ' + fieldText(v.child) : '');
    if (v.name) return wikiToText(String(v.name));
    if (v.key) return String(v.key);
  }
  return '';
}

// Секунды → запись в нотации Jira. День = 8 часов, неделя = 5 дней — умолчания Jira; компания
// может настроить иначе, поэтому это лишь запасной путь: если timetracking пришёл, берём его.
function secsToJira(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = Math.floor(n / 28800);
  const h = Math.floor((n % 28800) / 3600);
  const m = Math.round((n % 3600) / 60);
  return [d && d + 'd', h && h + 'h', m && m + 'm'].filter(Boolean).join(' ') || '0m';
}

// Wiki-разметка Jira → чистый текст. Нужен именно текст, а не оформление: карточка показывает
// описание как в самой задаче, и он же уходит агенту в промпт.
// Главное: содержимое {code}/{noformat} НЕ теряется — блоки сначала прячутся в плейсхолдеры,
// чтобы правила разметки не тронули код, и возвращаются в конце как есть.
function wikiToText(src) {
  let s = String(src || '').replace(/\r\n/g, '\n');
  const blocks = [];
  s = s.replace(/\{(code|noformat)(:[^}]*)?\}\n?([\s\S]*?)\{\1\}/g, (_m, _tag, _params, body) => {
    blocks.push(body.replace(/\n+$/, ''));
    return 'B' + (blocks.length - 1) + '';
  });

  s = s.replace(/\{(quote|panel|color|info|note|warning|tip)(:[^}]*)?\}/g, '');  // обёртки без содержимого
  s = s.replace(/\{anchor:[^}]*\}/g, '');
  s = s.replace(/\{(code|noformat)(:[^}]*)?\}/g, '');       // незакрытый блок — убираем только маркер
  s = s.replace(/^\s*h[1-6]\.\s*/gm, '');                   // h3. Заголовок → Заголовок
  s = s.replace(/^\s*bq\.\s*/gm, '');
  s = s.replace(/\[([^|\][]+)\|([^\]]+)\]/g, '$1 ($2)');    // [текст|ссылка]
  s = s.replace(/\[~([^\]]+)\]/g, '@$1');                   // [~login]
  s = s.replace(/\[([^\][|]+)\]/g, '$1');
  s = s.replace(/\{\{([^}]*)\}\}/g, '$1');                  // {{моноширинный}}
  // Парные маркеры начертания снимаем только вокруг слова, иначе пострадают «2*3» и «file_name».
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/g, '$1$2');
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,:;!?]|$)/g, '$1$2');
  s = s.replace(/(^|[\s(])\+([^+\n]+)\+(?=[\s).,:;!?]|$)/g, '$1$2');
  s = s.replace(/\\\\/g, '\n');                             // явный перенос строки
  s = s.replace(/^\s*-{4,}\s*$/gm, '─────');
  s = s.replace(/\n{3,}/g, '\n\n');

  // Поля с включённым рендерером приходят HTML-ом (<font color=…>Разработка</font>) — теги
  // снимаем, сущности раскрываем. Блоки кода к этому моменту в плейсхолдерах, их не заденет.
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  s = s.replace(/B(\d+)/g, (_m, i) => blocks[Number(i)] ?? '');
  return s.trim();
}

// «Рабочий» тип задачи. Порядок: явно выбранное поле → поля, подходящие по имени → поиск по
// всем пришедшим полям через карту имён (когда список запрошен как *navigable). Так бейдж
// появляется и без настройки, и при нестандартном названии поля.
function pickKind(f, extra = {}) {
  if (extra.typeFieldId) {
    const v = fieldText(f[extra.typeFieldId]);
    if (v) return v;
  }
  for (const id of (extra.typeIds || [])) {
    const v = fieldText(f[id]);
    if (v) return v;
  }
  if (extra.names) {
    for (const [id, name] of extra.names) {
      if (id === 'issuetype' || f[id] === undefined || f[id] === null) continue;
      const nm = String(name || '').trim().toLowerCase();
      if (!TYPE_FIELD_HINTS.includes(nm) && !nm.includes('тип задачи') && !nm.includes('тип работ')) continue;
      const v = fieldText(f[id]);
      if (v) return v;
    }
  }
  return '';
}

function person(u) {
  if (!u) return null;
  return { name: u.displayName || u.name || '', login: u.name || u.key || u.accountId || '' };
}

// ---------------------------------------------------------------- IPC
/** @param {{ ipcMain: import('electron').IpcMain, safeStorage?: any, getAccounts?: any, setAccounts?: any, storeDir?: string }} deps */
function registerJiraIpc({ ipcMain, safeStorage, getAccounts, setAccounts, storeDir }) {
  _safe = safeStorage; _get = getAccounts; _set = setAccounts; _dir = storeDir || '';

  ipcMain.handle('jira:list', () => ({
    ok: true, accounts: publicList(),
    secure: !!(safeStorage && safeStorage.isEncryptionAvailable()),
  }));

  // Создание/правка аккаунта. Токен приходит только когда его меняют; иначе блоб остаётся как был.
  ipcMain.handle('jira:save', (_e, { account } = {}) => {
    if (!account || !account.name) return { ok: false, error: 'нет данных аккаунта' };
    if (!account.host) return { ok: false, error: 'не задан адрес Jira' };
    const list = loadAccs();
    const idx = account.id ? list.findIndex((x) => x.id === account.id) : -1;
    const prev = idx >= 0 ? list[idx] : {};
    const rec = { ...prev, ...account };
    delete rec.hasToken;
    if (account.token != null) rec.tokenEnc = account.token ? enc(account.token) : '';
    delete rec.token;
    rec.host = String(rec.host).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(rec.host)) rec.host = 'https://' + rec.host;
    if (rec.mode !== 'basic' && rec.mode !== 'pat') rec.mode = 'pat';
    if (!rec.id) rec.id = 'jr' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
    if (idx >= 0) list[idx] = rec; else list.push(rec);
    saveAccs(list);
    searchMode.delete(rec.id); // сменили хост/режим → распознавать пагинацию заново
    fieldInfo.delete(rec.id);  // и поле типа задачи перечитать: его могли указать явно
    return { ok: true, id: rec.id, account: publicAcc(rec) };
  });

  ipcMain.handle('jira:delete', (_e, { id } = {}) => {
    saveAccs(loadAccs().filter((x) => x.id !== id));
    searchMode.delete(id);
    return { ok: true };
  });

  // Проверка: поля формы поверх сохранённых; токен — введённый, иначе сохранённый блоб.
  ipcMain.handle('jira:test', async (_e, { account } = {}) => {
    const saved = account && account.id ? (loadAccs().find((x) => x.id === account.id) || {}) : {};
    const cfg = { ...saved, ...account };
    cfg.tokenEnc = account && account.token != null ? (account.token ? enc(account.token) : '') : (saved.tokenEnc || '');
    if (!/^https?:\/\//i.test(cfg.host || '')) cfg.host = 'https://' + String(cfg.host || '').trim();
    cfg.host = String(cfg.host).replace(/\/+$/, '');
    try {
      const me = await api(cfg, 'GET', '/rest/api/2/myself');
      let server = null;
      try { server = await api(cfg, 'GET', '/rest/api/2/serverInfo'); } catch (_) {}
      return {
        ok: true,
        user: me.displayName || me.name || '',
        accountId: me.accountId || me.key || me.name || '',
        version: server ? (server.version || '') : '',
        deployment: server ? (server.deploymentType || '') : '',
      };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  const call = (fn) => async (_e, args = {}) => {
    try { return { ok: true, ...(await fn(accById(args.id), args)) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  };

  // Поля списка + поле спринта этой инсталляции (его id узнаём из /field, см. fieldsInfo).
  const listFieldsFor = async (a) => {
    const fi = await fieldsInfo(a);
    const known = !!(fi.typeFieldId || (fi.typeIds && fi.typeIds.length));
    const ids = [...new Set([fi.sprintId, fi.typeFieldId, ...(fi.typeIds || [])].filter(Boolean))];
    // Поле типа опознано — просим только его (дёшево). Не опознано ни одного кандидата —
    // берём *navigable и ищем значение по имени уже в ответе: бейдж важнее лишнего трафика.
    const fields = known ? LIST_FIELDS + (ids.length ? ',' + ids.join(',') : '') : '*navigable';
    return {
      fields,
      slim: { sprintId: fi.sprintId, typeFieldId: fi.typeFieldId, typeIds: fi.typeIds, names: known ? null : fi.names },
    };
  };

  // Задачи одного аккаунта.
  ipcMain.handle('jira:search', call(async (a, { preset, jql, limit }) => {
    const { fields, slim } = await listFieldsFor(a);
    const r = await searchAll(a, jqlFor(preset, jql), { limit, fields });
    return { issues: r.issues.map((it) => slimIssue(a, it, slim)), total: r.total, truncated: r.truncated };
  }));

  // Задачи по ВСЕМ (или выбранным) аккаунтам разом — главный экран мультиаккаунта.
  // allSettled, а не all: недоступная за VPN Jira не должна гасить выдачу остальных.
  ipcMain.handle('jira:searchAll', async (_e, { ids, preset, jql, limit } = {}) => {
    const list = loadAccs().filter((a) => (Array.isArray(ids) && ids.length ? ids.includes(a.id) : true));
    const res = await Promise.allSettled(list.map(async (a) => {
      const { fields, slim } = await listFieldsFor(a);
      const r = await searchAll(a, jqlFor(preset, jql), { limit, fields });
      return {
        accId: a.id, name: a.name, ok: true,
        issues: r.issues.map((it) => slimIssue(a, it, slim)),
        total: r.total, truncated: r.truncated,
      };
    }));
    return {
      ok: true,
      results: res.map((x, i) => x.status === 'fulfilled'
        ? x.value
        : { accId: list[i].id, name: list[i].name, ok: false, error: String((x.reason && x.reason.message) || x.reason), issues: [] }),
    };
  });

  // Карточка задачи: всё содержимое одним вызовом — описание, комментарии, связи, подзадачи,
  // люди, учёт времени и ВСЕ непустые поля инсталляции (fields=*all + карта имён из /field).
  ipcMain.handle('jira:issue', call(async (a, { key }) => {
    if (!key) throw new Error('не указан ключ задачи');
    const [it, fi] = await Promise.all([
      api(a, 'GET', '/rest/api/2/issue/' + encodeURIComponent(key) + '?' + q({ fields: '*all' })),
      fieldsInfo(a),
    ]);
    const names = fi.names;
    const f = it.fields || {};
    let transitions = [];
    try {
      const tr = await api(a, 'GET', '/rest/api/2/issue/' + encodeURIComponent(key) + '/transitions?expand=transitions.fields');
      transitions = (tr.transitions || []).map((t) => ({
        id: t.id, name: t.name,
        to: (t.to && t.to.name) || '',
        toCat: (t.to && t.to.statusCategory && t.to.statusCategory.key) || '',
        // Переход может требовать полей (resolution и пр.) — форму строим из ответа сервера,
        // а не из предположений о чужом воркфлоу.
        required: Object.entries(t.fields || {})
          .filter(([, v]) => v && v.required)
          .map(([id, v]) => ({ id, name: v.name || id, type: (v.schema && v.schema.type) || '' })),
      }));
    } catch (_) {}
    return {
      issue: {
        ...slimIssue(a, it, { sprintId: fi.sprintId, typeFieldId: fi.typeFieldId }),
        description: wikiToText(f.description),
        comments: ((f.comment && f.comment.comments) || []).slice(-30).map((c) => ({
          author: (c.author && c.author.displayName) || '', created: c.created || '', body: wikiToText(c.body),
        })),
        subtasks: (f.subtasks || []).map((s) => ({
          key: s.key, summary: (s.fields && s.fields.summary) || '',
          status: (s.fields && s.fields.status && s.fields.status.name) || '',
        })),
        links: (f.issuelinks || []).map((l) => {
          const other = l.outwardIssue || l.inwardIssue;
          return {
            type: (l.type && (l.outwardIssue ? l.type.outward : l.type.inward)) || '',
            key: other ? other.key : '', summary: (other && other.fields && other.fields.summary) || '',
          };
        }),
        components: (f.components || []).map((c) => c.name),
        // Родитель («Головная задача»): у подзадач это системное parent, у остальных приходит
        // кастомным полем — оно попадёт в custom ниже, здесь только системный случай.
        parentIssue: f.parent ? {
          key: f.parent.key,
          summary: (f.parent.fields && f.parent.fields.summary) || '',
          status: (f.parent.fields && f.parent.fields.status && f.parent.fields.status.name) || '',
        } : null,
        people: {
          assignee: person(f.assignee), reporter: person(f.reporter), creator: person(f.creator),
        },
        // timetracking заполнен не всегда — дублирующие системные поля надёжнее.
        time: {
          original: (f.timetracking && f.timetracking.originalEstimate) || (f.timeoriginalestimate ? secsToJira(f.timeoriginalestimate) : ''),
          remaining: (f.timetracking && f.timetracking.remainingEstimate) || (f.timeestimate ? secsToJira(f.timeestimate) : ''),
          spent: (f.timetracking && f.timetracking.timeSpent) || (f.timespent ? secsToJira(f.timespent) : ''),
          // Секунды — для полосы «затрачено от оценки»: разбирать «2d 4h» на фронте было бы
          // гаданием о настройках рабочего дня конкретной инсталляции.
          originalSecs: Number(f.timeoriginalestimate) || 0,
          remainingSecs: Number(f.timeestimate) || 0,
          spentSecs: Number(f.timespent) || 0,
        },
        // Всё остальное непустое — с человеческими именами из /field. Так «Ранг задачи»,
        // «В группу разработки», Sprint и любые поля чужой инсталляции видны без правки кода.
        custom: Object.entries(f)
          .filter(([id, v]) => !SKIP_FIELDS.has(id) && v !== null && v !== undefined && v !== ''
            && !(Array.isArray(v) && !v.length))
          .map(([id, v]) => ({ name: names.get(id) || id, value: fieldText(v) }))
          .filter((x) => x.value)
          .sort((x, y) => x.name.localeCompare(y.name, 'ru')),
      },
      transitions,
    };
  }));

  // Список кастомных полей — для явного выбора «поля типа задачи» в настройках аккаунта.
  // Автоопределение по имени промахивается, если поле названо нестандартно; выбор руками надёжнее.
  ipcMain.handle('jira:fields', call(async (a) => {
    const fi = await fieldsInfo(a);
    const all = [];
    for (const [id, name] of fi.names) if (id.startsWith('customfield_')) all.push({ id, name });
    all.sort((x, y) => x.name.localeCompare(y.name, 'ru'));
    return { fields: all, typeFieldId: fi.typeFieldId };
  }));

  // Полный справочник статусов и типов инсталляции. Нужен фильтрам «показывать/прятать»:
  // в текущей выдаче встречается лишь часть статусов, а спрятать пользователь хочет любой.
  // Справочник необязателен — если эндпоинт закрыт правами, фильтр просто соберётся по выдаче.
  ipcMain.handle('jira:meta', call(async (a) => {
    const soft = async (p) => { try { return await api(a, 'GET', p); } catch (_) { return []; } };
    const [st, ty] = await Promise.all([soft('/rest/api/2/status'), soft('/rest/api/2/issuetype')]);
    const seenS = new Set(), seenT = new Set();
    const statuses = [];
    for (const s of (Array.isArray(st) ? st : [])) {
      if (!s || !s.name || seenS.has(s.name)) continue;   // одноимённые статусы разных схем — один раз
      seenS.add(s.name);
      statuses.push({ name: s.name, category: (s.statusCategory && s.statusCategory.key) || '' });
    }
    const types = [];
    for (const t of (Array.isArray(ty) ? ty : [])) {
      if (!t || !t.name || seenT.has(t.name)) continue;
      seenT.add(t.name);
      types.push(t.name);
    }
    return { statuses, types };
  }));

  // Доски Agile: список + принадлежность задач. Модуля Agile может не быть (Core/JSM) — тогда
  // boards приходит пустым и вкладка досок в UI не показывается.
  ipcMain.handle('jira:boards', call(async (a, { withIssues }) => {
    const r = await api(a, 'GET', '/rest/agile/1.0/board?' + q({ maxResults: 100 }));
    const boards = (r.values || []).map((b) => ({
      id: b.id, name: b.name, type: b.type || '', project: (b.location && b.location.projectKey) || '',
    }));
    if (!withIssues) return { boards };
    // Карта задача→доски строится по СВОИМ задачам каждой доски: тянем только ключи, поэтому
    // даже десяток досок обходится дёшево. Доска, которая не ответила, просто не даёт лейблов.
    const perBoard = await Promise.allSettled(boards.map(async (b) => {
      const res = await api(a, 'GET', '/rest/agile/1.0/board/' + b.id + '/issue?' + q({
        jql: 'assignee = currentUser()', fields: 'key', maxResults: 200,
      }));
      return { id: b.id, keys: (res.issues || []).map((i) => i.key) };
    }));
    const map = {};
    for (const x of perBoard) {
      if (x.status !== 'fulfilled') continue;
      for (const k of x.value.keys) (map[k] = map[k] || []).push(x.value.id);
    }
    return { boards, issueBoards: map };
  }));

  ipcMain.handle('jira:transition', call(async (a, { key, transitionId, fields }) => {
    if (!key || !transitionId) throw new Error('не указана задача или переход');
    await api(a, 'POST', '/rest/api/2/issue/' + encodeURIComponent(key) + '/transitions',
      { transition: { id: String(transitionId) }, ...(fields && Object.keys(fields).length ? { fields } : {}) });
    return {};
  }));

  ipcMain.handle('jira:comment', call(async (a, { key, body }) => {
    if (!key || !String(body || '').trim()) throw new Error('пустой комментарий');
    await api(a, 'POST', '/rest/api/2/issue/' + encodeURIComponent(key) + '/comment', { body: String(body) });
    return {};
  }));

  // Разведка структуры — то, из чего видно устройство конкретной Jira.
  ipcMain.handle('jira:recon', call(async (a, { withTexts }) => ({ report: await recon(a, { withTexts }) })));

  // Отчёт на диск: ~/.LiteEditorAI/jira/recon-<id>-<дата>.json. Токена в отчёте нет
  // (в него кладётся publicAcc-срез), поэтому файл безопасно отдать агенту.
  ipcMain.handle('jira:reconSave', async (_e, { report } = {}) => {
    try {
      if (!report) return { ok: false, error: 'нет отчёта' };
      if (!_dir) return { ok: false, error: 'не задан каталог данных' };
      const dir = path.join(_dir, 'jira');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const accId = (report.account && report.account.id) || 'acc';
      const file = path.join(dir, 'recon-' + accId + '-' + stamp + '.json');
      fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
      return { ok: true, file };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  return {};
}

module.exports = {
  registerJiraIpc,
  _test: { enc, dec, api, slimIssue, jqlFor, searchAll, recon, readResponse, PRESETS, fieldText, secsToJira, normalizeHost, wikiToText },
};
