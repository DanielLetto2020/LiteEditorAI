// LiteEditor — модуль «Мониторинг сайтов» (target → checks). Окно-модуль из меню «Модули».
// Модель: ЦЕЛЬ (URL + общие настройки) → много ЧЕКОВ (статус-рамок). Один чек = одно условие над URL.
//   • basic  — декларативная проверка из полей (экстрактор → компаратор → ожидание / «изменилось»);
//   • custom — чистая функция-предикат, которую пишет агент в чате (мини-парсер), исполняется в main.
// main грузит URL один раз за цикл и прогоняет все чеки цели; на смену состояния — уведомление.
// Это окно — UI: цели/чеки (добавить/править/удалить), предпросмотр правила на живом ответе, чат с агентом.
import { el, icon, iconBtn, toast, makeModal, showConfirm } from '../ui.js';
import { createCodeEditor, ensureLanguage } from '../codeedit.js';

const lite = window.lite;
const $ = (s) => document.querySelector(s);

// ── справочники экстракторов / компараторов / пресетов ──────────────────────────────────────────────
const SOURCES = [
  { id: 'status', label: 'HTTP-код', path: false },
  { id: 'latency', label: 'Задержка (мс)', path: false },
  { id: 'json', label: 'Поле JSON', path: 'путь: data.status, items[0].price' },
  { id: 'text', label: 'Весь текст страницы', path: false },
  { id: 'regex', label: 'По регэкспу', path: 'шаблон, напр. цена:\\s*(\\d+)' },
  { id: 'header', label: 'Заголовок ответа', path: 'имя, напр. content-type' },
  { id: 'css', label: 'CSS-селектор (рендер)', path: 'селектор, напр. .price' },
];
const CMPS = [
  { id: 'eq', label: '= равно' },
  { id: 'ne', label: '≠ не равно' },
  { id: 'lt', label: '< меньше' },
  { id: 'le', label: '≤ не больше' },
  { id: 'gt', label: '> больше' },
  { id: 'ge', label: '≥ не меньше' },
  { id: 'contains', label: 'содержит' },
  { id: 'ncontains', label: 'не содержит' },
  { id: 'matches', label: 'совпадает с regex' },
  { id: 'exists', label: 'существует' },
  { id: 'changed', label: 'изменилось' },
];
const NO_EXPECTED = new Set(['exists', 'changed', 'up']);
const PRESETS = [
  { label: 'Доступность', title: 'Доступность', source: 'status', cmp: 'up' },
  { label: 'Код = 200', title: 'HTTP-код = 200', source: 'status', cmp: 'eq', expected: '200' },
  { label: 'Поле JSON', title: 'Поле JSON', source: 'json', cmp: 'eq' },
  { label: 'Есть текст', title: 'Есть текст на странице', source: 'text', cmp: 'contains' },
  { label: 'Нет текста', title: 'Нет текста на странице', source: 'text', cmp: 'ncontains' },
  { label: 'Число < порога', title: 'Число ниже порога', source: 'json', cmp: 'lt' },
  { label: 'Изменилось', title: 'Значение изменилось', source: 'json', cmp: 'changed' },
];

const SYSTEM_PROMPT = [
  'Ты пишешь предикат-функцию для мониторинга веб-страницы/URL в редакторе LiteEditor.',
  'Функция ЧИСТАЯ и СИНХРОННАЯ, вида: (input) => ({ status, value, label }).',
  'Поля input:',
  '  input.ok      — удалось ли загрузить URL (boolean);',
  '  input.status  — HTTP-код (число);',
  '  input.ms      — задержка загрузки, мс;',
  '  input.headers — объект заголовков ответа (ключи в нижнем регистре);',
  '  input.text    — тело ответа строкой (HTML/текст; при режиме «рендерить» — видимый текст страницы);',
  '  input.json    — распарсенный JSON (или undefined, если тело не JSON);',
  '  input.url     — сам URL.',
  'Верни объект { status, value, label }:',
  '  status — состояние чека, ОДНО из четырёх (по цвету рамки):',
  '     "ok"    — 🟢 в норме (всё хорошо);',
  '     "warn"  — 🟡 внимание (подозрительно / деградация / близко к порогу);',
  '     "alert" — 🔴 тревога (проблема, надо реагировать) — про неё придёт уведомление;',
  '     "info"  — 🔵 инфо (примечательное значение/событие, но НЕ проблема).',
  '  value — короткое извлечённое значение (число/строка) для показа в статус-рамке;',
  '  label — (необязательно) человекочитаемая подпись состояния.',
  'Можно возвращать РАЗНЫЙ status в зависимости от данных (напр. ok/warn/alert по порогам) или всегда один.',
  'Совместимость: вместо status допустимо вернуть ok:true (→ok) / ok:false (→alert).',
  'Правила: только синхронный код, без сети/файлов/require/бесконечных циклов. Доступны JSON, Math, RegExp, String, Number, Array и т.п.',
  'Формат ответа (строго): СНАЧАЛА один блок ```js с функцией, ПОТОМ 1–2 предложения, что она проверяет, и отдельной строкой «Заголовок: …» — короткое имя чека.',
  'Опирайся на реальную структуру из живого сэмпла ниже. Отвечай по-русски.',
].join('\n');

// ── форматирование ──────────────────────────────────────────────────────────────────────────────────
function fmtAgo(ts) {
  if (!ts) return 'ещё не проверялся';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 5) return 'только что';
  if (sec < 60) return sec + ' с назад';
  if (sec < 3600) return Math.floor(sec / 60) + ' мин назад';
  return Math.floor(sec / 3600) + ' ч назад';
}
function fmtInt(n) { n = Number(n) || 0; if (n < 60) return n + ' с'; if (n < 3600) return (n % 60 ? Math.floor(n / 60) + ' мин ' + (n % 60) + ' с' : Math.floor(n / 60) + ' мин'); return Math.floor(n / 3600) + ' ч'; }
function stateLabel(s) { return s === 'ok' ? 'в норме' : s === 'triggered' ? 'тревога' : s === 'warn' ? 'внимание' : s === 'info' ? 'инфо' : s === 'error' ? 'ошибка' : 'проверяется…'; }
function rank(s) { return s === 'triggered' ? 0 : s === 'warn' ? 1 : s === 'error' ? 2 : s === 'info' ? 3 : s === 'unknown' ? 4 : 5; }
function plural(n, a, b, c) { const m = n % 100; if (m >= 11 && m <= 14) return c; const d = n % 10; return d === 1 ? a : d >= 2 && d <= 4 ? b : c; }
function rollup(checks) {
  if (!checks || !checks.length) return { state: 'unknown', ok: 0, trig: 0, warn: 0, info: 0, err: 0, n: 0 };
  let ok = 0, trig = 0, warn = 0, info = 0, err = 0;
  for (const c of checks) { const s = c.state; if (s === 'ok') ok++; else if (s === 'triggered') trig++; else if (s === 'warn') warn++; else if (s === 'info') info++; else if (s === 'error') err++; }
  const state = trig ? 'triggered' : warn ? 'warn' : err ? 'error' : info ? 'info' : ok ? 'ok' : 'unknown';
  return { state, ok, trig, warn, info, err, n: checks.length };
}
function fmtBytes(n) { n = Number(n) || 0; return n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(1) + ' КБ' : (n / 1048576).toFixed(2) + ' МБ'; }

// маленький ✕ в углу модалки (makeModal сам его не рисует)
function addCloseX(m, close) { const x = el('button', 'sm-modal-x'); x.setAttribute('title', 'Закрыть (Esc)'); x.textContent = '✕'; x.addEventListener('click', close); m.appendChild(x); return x; }

// сворачиваемое JSON-дерево (полное, без обрезки; первый уровень раскрыт)
function jsonTree(value, key, depth) {
  const wrap = el('div', 'sm-jt');
  const line = el('div', 'sm-jt-line');
  const isObj = value !== null && typeof value === 'object';
  const keys = isObj ? (Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value)) : null;
  const ob = isObj ? (Array.isArray(value) ? '[' : '{') : '';
  const cb = isObj ? (Array.isArray(value) ? ']' : '}') : '';
  if (isObj && keys.length) {
    const tog = el('span', 'sm-jt-tog');
    line.appendChild(tog);
    if (key !== null) line.appendChild(el('span', 'sm-jt-key', key + ': '));
    line.appendChild(el('span', 'sm-jt-brace', ob));
    const count = el('span', 'sm-jt-count', ' … ' + keys.length + ' '); const cbInline = el('span', 'sm-jt-brace', cb);
    line.append(count, cbInline);
    const kids = el('div', 'sm-jt-kids');
    const closeLine = el('div', 'sm-jt-line sm-jt-close'); closeLine.appendChild(el('span', 'sm-jt-brace', cb));
    let built = false;
    const build = () => { if (built) return; built = true; for (const k of keys) kids.appendChild(jsonTree(value[k], Array.isArray(value) ? null : k, depth + 1)); };
    let open = depth < 1;
    const apply = () => { tog.textContent = open ? '▾' : '▸'; count.style.display = open ? 'none' : ''; cbInline.style.display = open ? 'none' : ''; kids.style.display = open ? '' : 'none'; closeLine.style.display = open ? '' : 'none'; if (open) build(); };
    line.style.cursor = 'pointer'; line.addEventListener('click', () => { open = !open; apply(); });
    wrap.append(line, kids, closeLine); apply();
  } else {
    if (key !== null) line.appendChild(el('span', 'sm-jt-key', key + ': '));
    if (isObj) line.appendChild(el('span', 'sm-jt-brace', ob + cb));
    else { const cls = value === null ? 'null' : typeof value; line.appendChild(el('span', 'sm-jt-val ' + cls, typeof value === 'string' ? JSON.stringify(value) : String(value))); }
    wrap.appendChild(line);
  }
  return wrap;
}

// рендер живого сэмпла: json → дерево/код, html → код/превью, text → текст (всё с подсветкой; disposers — на закрытие)
function renderSample(container, sample, disposers) {
  container.textContent = '';
  if (!sample) { container.appendChild(el('div', 'sm-ai-empty', 'Сэмпл не загружен — нажмите «Обновить сэмпл».')); return; }
  if (!sample.ok) { container.appendChild(el('div', 'sm-dry err', '⚠ ' + (sample.error || 'нет связи'))); return; }
  const head = el('div', 'sm-smp-head');
  head.appendChild(el('span', 'sm-smp-meta', 'HTTP ' + sample.status + (sample.ctype ? ' · ' + sample.ctype.split(';')[0] : '') + ' · ' + fmtBytes(sample.bytes) + (sample.rendered ? ' · рендер' : '') + (sample.bodyTrunc ? ' · обрезано 2МБ' : '')));
  const tabs = el('div', 'sm-smp-tabs'); head.appendChild(tabs);
  container.appendChild(head);
  const view = el('div', 'sm-smp-view'); container.appendChild(view);
  const showTree = () => { view.textContent = ''; const root = el('div', 'sm-jt-root'); root.appendChild(jsonTree(sample.json, null, 0)); view.appendChild(root); };
  const showCode = (fname, text) => { view.textContent = ''; const host = el('div', 'sm-smp-code'); view.appendChild(host); ensureLanguage(fname).then((support) => { const ed = createCodeEditor(host, { doc: text, readOnly: true, language: support }); disposers.push(() => { try { ed.destroy(); } catch (_) {} }); }); };
  const showPreview = (html) => { view.textContent = ''; const fr = el('iframe', 'sm-smp-frame'); fr.setAttribute('sandbox', ''); fr.setAttribute('referrerpolicy', 'no-referrer'); fr.srcdoc = html; view.appendChild(fr); };
  const mk = (label, on) => { const b = el('button', 'sm-smp-tab', label); b.addEventListener('click', () => { [...tabs.children].forEach((x) => x.classList.remove('on')); b.classList.add('on'); on(); }); tabs.appendChild(b); return b; };
  const kind = sample.kind || 'text';
  if (kind === 'json') { const t = mk('Дерево', showTree); mk('Код', () => showCode('sample.json', JSON.stringify(sample.json, null, 2))); t.classList.add('on'); showTree(); }
  else if (kind === 'html') { const c = mk('Код', () => showCode('sample.html', sample.body || '')); mk('Превью', () => showPreview(sample.body || '')); c.classList.add('on'); showCode('sample.html', sample.body || ''); }
  else { const c = mk('Текст', () => showCode('sample.txt', sample.body || '')); c.classList.add('on'); showCode('sample.txt', sample.body || ''); }
}

// ── статистика/графики за месяц ─────────────────────────────────────────────────────────────────────
function svgTag(tag) { return document.createElementNS('http://www.w3.org/2000/svg', tag); }
function last30Keys() { const out = []; const now = new Date(); for (let i = 29; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i); out.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')); } return out; }
function aggDays(checks) {
  const map = new Map();
  for (const c of (checks || [])) for (const b of (c.stats || [])) { let a = map.get(b.d); if (!a) { a = { d: b.d, total: 0, ok: 0, warn: 0, trig: 0, info: 0, err: 0, msSum: 0, msN: 0 }; map.set(b.d, a); } a.total += b.total || 0; a.ok += b.ok || 0; a.warn += b.warn || 0; a.trig += b.trig || 0; a.info += b.info || 0; a.err += b.err || 0; a.msSum += b.msSum || 0; a.msN += b.msN || 0; }
  return map;
}
function statSummary(days) { let total = 0, ok = 0, msSum = 0, msN = 0, downDays = 0; for (const b of days) { total += b.total; ok += b.ok; msSum += b.msSum; msN += b.msN; if (b.total && b.trig > 0) downDays++; } return { uptime: total ? (ok / total * 100) : null, avgMs: msN ? Math.round(msSum / msN) : null, checks: total, downDays }; }
function dayRatio(b) { return b && b.total ? b.ok / b.total : null; }
function ratioColor(r) { if (r == null) return 'var(--border)'; if (r >= 0.999) return 'var(--green)'; if (r >= 0.99) return 'var(--green-bright, var(--green))'; if (r >= 0.9) return 'var(--warn)'; return 'var(--danger)'; }
function statTile(val, label, cls) { const t = el('div', 'sm-tile' + (cls ? ' ' + cls : '')); t.appendChild(el('div', 'sm-tile-v', val)); t.appendChild(el('div', 'sm-tile-l', label)); return t; }
function uptimeStrip(map) {
  const strip = el('div', 'sm-strip');
  for (const k of last30Keys()) { const b = map.get(k); const r = dayRatio(b); const cell = el('div', 'sm-strip-cell'); cell.style.background = ratioColor(r); cell.title = k + (b ? ' · аптайм ' + (r * 100).toFixed(1) + '% (' + b.ok + '/' + b.total + ')' + (b.msN ? ' · ' + Math.round(b.msSum / b.msN) + ' мс' : '') : ' · нет данных'); strip.appendChild(cell); }
  return strip;
}
function latencyLine(map) {
  const keys = last30Keys();
  const vals = keys.map((k) => { const b = map.get(k); return b && b.msN ? Math.round(b.msSum / b.msN) : null; });
  const present = vals.filter((v) => v != null);
  if (present.length < 2) return null;
  const max = Math.max(...present), W = 100, H = 30;
  const svg = svgTag('svg'); svg.setAttribute('class', 'sm-line'); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('preserveAspectRatio', 'none');
  const pts = []; vals.forEach((v, i) => { if (v == null) return; const x = (i / (keys.length - 1)) * W; const y = H - 2 - (max ? (v / max) * (H - 4) : 0); pts.push(x.toFixed(1) + ',' + y.toFixed(1)); });
  const pl = svgTag('polyline'); pl.setAttribute('points', pts.join(' ')); pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', 'var(--info)'); pl.setAttribute('stroke-width', '1.4'); pl.setAttribute('vector-effect', 'non-scaling-stroke'); pl.setAttribute('stroke-linejoin', 'round'); svg.appendChild(pl);
  const wrap = el('div', 'sm-line-wrap'); wrap.appendChild(svg); wrap.appendChild(el('span', 'sm-line-max', 'макс ' + max + ' мс')); return wrap;
}

export function initSitemon(host) {
  const STORE = (host && host.STORE) || {};
  const persist = (host && host.persist) || (() => {});
  let targets = [];
  let unsub = null;
  let viewMode = ((STORE.sitemonUi && STORE.sitemonUi.viewMode) === 'charts') ? 'charts' : 'blocks';
  const body = $('#sitemon-body');

  async function reload() { try { targets = (await lite.sitemon.list()) || []; render(); } catch (_) {} }
  function smUi() { return (STORE.sitemonUi && typeof STORE.sitemonUi === 'object') ? STORE.sitemonUi : {}; }
  function saveUi(patch) { persist('sitemonUi', Object.assign({}, smUi(), patch)); }

  // ── провайдеры агента (общие с модулем «Базы данных») ──────────────────────────────────────────────
  function providersCfg() { return (STORE.dbaiProviders && typeof STORE.dbaiProviders === 'object') ? STORE.dbaiProviders : {}; }
  function agentOptions() {
    const opts = [{ id: 'claude', label: 'Claude (CLI)' }, { id: 'codex', label: 'Codex (CLI)' }];
    const p = providersCfg();
    for (const mo of ((p.openrouter && p.openrouter.models) || [])) opts.push({ id: 'or::' + mo.id, label: 'OR · ' + (mo.name || mo.id) });
    for (const mo of ((p.ollama && p.ollama.models) || [])) opts.push({ id: 'ollama::' + mo.id, label: 'Ollama · ' + (mo.name || mo.id) });
    for (const mo of ((p.lmstudio && p.lmstudio.models) || [])) opts.push({ id: 'lmstudio::' + mo.id, label: 'LM · ' + (mo.name || mo.id) });
    return opts;
  }
  function parseAgentId(id) { const i = String(id).indexOf('::'); return i < 0 ? { kind: id, model: null } : { kind: id.slice(0, i), model: id.slice(i + 2) }; }
  function providerEndpoint(kind) {
    const p = providersCfg();
    if (kind === 'or') return { base: 'https://openrouter.ai/api/v1', key: (p.openrouter && p.openrouter.key) || '' };
    if (kind === 'ollama') return { base: ((p.ollama && p.ollama.baseUrl) || 'http://localhost:11434').replace(/\/+$/, '') + '/v1', key: '' };
    if (kind === 'lmstudio') return { base: ((p.lmstudio && p.lmstudio.baseUrl) || 'http://localhost:1234').replace(/\/+$/, '') + '/v1', key: '' };
    return null;
  }
  // Одна отправка агенту (одношотовый стрим dbai). Возвращает { abort }.
  function runAgent(agentId, prompt, cbs) {
    const reqId = 'smai-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    let offData, offDone, offErr, ended = false;
    const cleanup = () => { if (ended) return; ended = true; offData && offData(); offDone && offDone(); offErr && offErr(); };
    offData = lite.dbai.onData((d) => { if (d.reqId === reqId) cbs.onData(d.chunk || ''); });
    offDone = lite.dbai.onDone((d) => { if (d.reqId !== reqId) return; cleanup(); cbs.onDone(); });
    offErr = lite.dbai.onError((d) => { if (d.reqId !== reqId) return; cleanup(); cbs.onError(d.error || 'ошибка агента'); });
    const ag = parseAgentId(agentId);
    if (ag.kind === 'claude' || ag.kind === 'codex') { lite.dbai.run(reqId, ag.kind, prompt); }
    else {
      const ep = providerEndpoint(ag.kind);
      if (!ep || !ag.model) { cleanup(); cbs.onError('Провайдер не настроен. Настройте модели в модуле «Базы данных» → выбор агента.'); return { abort() {} }; }
      if (ag.kind === 'or' && !ep.key) { cleanup(); cbs.onError('Не задан API-ключ OpenRouter (модуль «Базы данных» → настроить модели).'); return { abort() {} }; }
      lite.dbai.apiRun(reqId, { baseUrl: ep.base, key: ep.key, model: ag.model, prompt });
    }
    return { abort() { try { lite.dbai.abort(reqId); } catch (_) {} cleanup(); } };
  }

  // ── диалог цели (URL): добавить / править ───────────────────────────────────────────────────────────
  function targetDialog(existing) {
    const { m, close } = makeModal(`<h2>${existing ? 'Настройки цели' : 'Новая цель (URL)'}</h2><div class="sm-form"></div><div class="modal-actions"><button class="btn" id="sm-cancel">Отмена</button><button class="btn primary" id="sm-save">${existing ? 'Сохранить' : 'Добавить'}</button></div>`);
    m.classList.add('sm-modal'); addCloseX(m, close);
    const f = m.querySelector('.sm-form');
    const url = el('input', 'sm-in'); url.placeholder = 'https://example.com/api'; url.value = existing ? existing.url : ''; url.spellcheck = false;
    const name = el('input', 'sm-in'); name.placeholder = 'Название (необязательно)'; name.value = existing ? (existing.name || '') : '';
    const intv = el('input', 'sm-in'); intv.type = 'number'; intv.min = '15'; intv.max = '86400'; intv.value = existing ? existing.intervalSec : 60;
    const renderCb = el('input'); renderCb.type = 'checkbox'; renderCb.checked = existing ? !!existing.render : false;
    const insecureCb = el('input'); insecureCb.type = 'checkbox'; insecureCb.checked = existing ? !!existing.insecureTls : false;
    const hdr = el('textarea', 'sm-in sm-hdr'); hdr.placeholder = 'Заголовки, по одному в строке:\nAuthorization: Bearer …'; hdr.rows = 3;
    if (existing && existing.headers) hdr.value = Object.entries(existing.headers).map(([k, v]) => k + ': ' + v).join('\n');
    f.appendChild(el('label', 'sm-l', 'URL')); f.appendChild(url);
    f.appendChild(el('label', 'sm-l', 'Название')); f.appendChild(name);
    f.appendChild(el('label', 'sm-l', 'Интервал проверки, сек (15–86400)')); f.appendChild(intv);
    const rlab = el('label', 'sm-check'); rlab.appendChild(renderCb); rlab.appendChild(el('span', null, 'Рендерить страницу (для SPA / CSS-селекторов — тяжелее)')); f.appendChild(rlab);
    const ilab = el('label', 'sm-check'); ilab.appendChild(insecureCb); ilab.appendChild(el('span', null, 'Разрешить самоподписанный TLS-сертификат (небезопасно — MITM)')); f.appendChild(ilab);
    const hwrap = el('details', 'sm-adv'); hwrap.appendChild(el('summary', null, 'Заголовки запроса (авторизация и т.п.)')); hwrap.appendChild(hdr); f.appendChild(hwrap);
    if (existing && existing.headers) hwrap.open = true;
    function parseHeaders(txt) { const out = {}; for (const line of String(txt || '').split('\n')) { const i = line.indexOf(':'); if (i < 0) continue; const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim(); if (k) out[k] = v; } return Object.keys(out).length ? out : null; }
    m.querySelector('#sm-cancel').addEventListener('click', close);
    m.querySelector('#sm-save').addEventListener('click', async () => {
      const payload = { name: name.value, url: url.value, intervalSec: parseInt(intv.value, 10) || 60, render: renderCb.checked, insecureTls: insecureCb.checked, headers: parseHeaders(hdr.value) };
      const r = existing ? await lite.sitemon.editTarget(existing.id, payload) : await lite.sitemon.addTarget(payload);
      if (r && r.ok) { close(); reload(); } else toast((r && r.error) || 'Не удалось сохранить', { kind: 'err' });
    });
    setTimeout(() => url.focus(), 30);
  }

  // ── выбор типа чека ─────────────────────────────────────────────────────────────────────────────────
  function checkChooser(target) {
    const { m, close } = makeModal('<h2>Новый чек над URL</h2><div class="sm-choose"></div><div class="modal-actions"><button class="btn" id="sm-cc-cancel">Отмена</button></div>');
    m.classList.add('sm-modal'); addCloseX(m, close);
    const box = m.querySelector('.sm-choose');
    const b1 = el('button', 'sm-choice');
    b1.appendChild(el('div', 'sm-choice-t', 'Базовый'));
    b1.appendChild(el('div', 'sm-choice-d', 'Из полей: код / поле JSON / текст / число / «изменилось». Без ИИ, быстро.'));
    b1.addEventListener('click', () => { close(); basicCheckDialog(target, null); });
    const b2 = el('button', 'sm-choice');
    b2.appendChild(el('div', 'sm-choice-t', 'Кастомный (агент)'));
    b2.appendChild(el('div', 'sm-choice-d', 'Опишите словами — агент напишет мини-парсер под этот URL. Правится и удаляется как обычный чек.'));
    b2.addEventListener('click', () => { close(); customCheckDialog(target, null); });
    box.append(b1, b2);
    m.querySelector('#sm-cc-cancel').addEventListener('click', close);
  }

  function renderDry(box, r) {
    box.textContent = '';
    if (!r || !r.ok) { box.className = 'sm-dry err'; box.textContent = '⚠ ' + ((r && r.error) || 'не удалось проверить'); return; }
    const st = r.state; box.className = 'sm-dry ' + st;
    const LBL = { ok: 'В норме 🟢', warn: 'Внимание 🟡', triggered: 'Тревога 🔴', info: 'Инфо 🔵', error: 'Ошибка' };
    box.appendChild(el('span', 'sm-dry-dot ' + st));
    box.appendChild(el('b', null, LBL[st] || st));
    if (r.error) box.appendChild(el('span', 'sm-dry-v', '· ' + r.error));
    else if (r.value != null && r.value !== '') box.appendChild(el('span', 'sm-dry-v', '· ' + r.value));
    const meta = 'HTTP ' + (r.capStatus != null ? r.capStatus : '—') + (r.rendered ? ' · рендер' : '') + (r.renderError ? ' · рендер: ' + r.renderError : '');
    box.appendChild(el('span', 'sm-dry-meta', meta));
  }

  // ── форма базового чека ─────────────────────────────────────────────────────────────────────────────
  function basicCheckDialog(target, existing) {
    const { m, close } = makeModal(`<h2>${existing ? 'Изменить чек' : 'Базовый чек'}</h2><div class="sm-form"></div><div class="sm-dry" id="sm-dry"></div><div class="modal-actions"><button class="btn" id="sm-b-test">Проверить сейчас</button><span style="flex:1"></span><button class="btn" id="sm-b-cancel">Отмена</button><button class="btn primary" id="sm-b-save">${existing ? 'Сохранить' : 'Добавить'}</button></div>`);
    m.classList.add('sm-modal'); addCloseX(m, close);
    const f = m.querySelector('.sm-form');
    const spec = existing ? Object.assign({ source: 'status', cmp: 'up', path: '', expected: '', level: 'alert' }, existing.spec) : { source: 'status', cmp: 'up', path: '', expected: '', level: 'alert' };

    const chips = el('div', 'sm-chips');
    for (const p of PRESETS) { const b = el('button', 'sm-chip', p.label); b.addEventListener('click', () => { spec.source = p.source; spec.cmp = p.cmp; if (p.expected != null) spec.expected = p.expected; title.value = p.title; sync(); }); chips.appendChild(b); }
    f.appendChild(el('label', 'sm-l', 'Быстрый выбор')); f.appendChild(chips);

    const title = el('input', 'sm-in'); title.placeholder = 'Что проверяет'; title.value = existing ? (existing.title || '') : 'Проверка';
    f.appendChild(el('label', 'sm-l', 'Заголовок чека')); f.appendChild(title);

    const src = el('select', 'sm-in'); for (const s of SOURCES) { const o = el('option', null, s.label); o.value = s.id; src.appendChild(o); }
    f.appendChild(el('label', 'sm-l', 'Что берём')); f.appendChild(src);

    const pathL = el('label', 'sm-l', 'Путь / шаблон'); const path = el('input', 'sm-in'); path.spellcheck = false;
    f.appendChild(pathL); f.appendChild(path);

    const cmp = el('select', 'sm-in');
    f.appendChild(el('label', 'sm-l', 'Условие «в норме»')); f.appendChild(cmp);

    const expL = el('label', 'sm-l', 'Ожидаемое значение'); const exp = el('input', 'sm-in'); exp.spellcheck = false;
    f.appendChild(expL); f.appendChild(exp);

    const lvlL = el('label', 'sm-l', 'Уровень при срабатывании');
    const lvl = el('select', 'sm-in'); for (const L of [{ id: 'alert', label: '🔴 Тревога (красный)' }, { id: 'warn', label: '🟡 Внимание (жёлтый)' }, { id: 'info', label: '🔵 Инфо (синий)' }]) { const o = el('option', null, L.label); o.value = L.id; lvl.appendChild(o); }
    lvl.value = spec.level || 'alert'; lvl.addEventListener('change', () => { spec.level = lvl.value; });
    f.appendChild(lvlL); f.appendChild(lvl);

    const adv = el('details', 'sm-adv'); adv.appendChild(el('summary', null, 'Уведомления и защита от дребезга'));
    const notifyCb = el('input'); notifyCb.type = 'checkbox'; notifyCb.checked = existing ? existing.notify !== false : true;
    const nlab = el('label', 'sm-check'); nlab.appendChild(notifyCb); nlab.appendChild(el('span', null, 'Уведомлять при срабатывании/восстановлении')); adv.appendChild(nlab);
    const deb = el('input', 'sm-in'); deb.type = 'number'; deb.min = '1'; deb.max = '10'; deb.value = existing ? (existing.debounce || 1) : 1;
    adv.appendChild(el('label', 'sm-l', 'Подтверждений подряд перед сменой (1 = сразу)')); adv.appendChild(deb);
    f.appendChild(adv);

    function curSourceMeta() { return SOURCES.find((s) => s.id === src.value) || SOURCES[0]; }
    function sync() {
      src.value = spec.source; path.value = spec.path || ''; exp.value = spec.expected || '';
      const sm = curSourceMeta();
      const showPath = !!sm.path; pathL.style.display = path.style.display = showPath ? '' : 'none'; if (showPath) path.placeholder = sm.path;
      const showUp = spec.source === 'status';
      let list = CMPS.slice(); if (showUp) list = [{ id: 'up', label: 'доступен (HTTP < 400)' }].concat(list);
      cmp.textContent = ''; for (const c of list) { const o = el('option', null, c.label); o.value = c.id; cmp.appendChild(o); }
      cmp.value = spec.cmp; if (cmp.selectedIndex < 0) { spec.cmp = list[0].id; cmp.value = spec.cmp; }
      const showExp = !NO_EXPECTED.has(spec.cmp); expL.style.display = exp.style.display = showExp ? '' : 'none';
      const showLvl = spec.cmp !== 'up'; lvlL.style.display = lvl.style.display = showLvl ? '' : 'none'; lvl.value = spec.level || 'alert';
    }
    src.addEventListener('change', () => { spec.source = src.value; if (spec.source !== 'status' && spec.cmp === 'up') spec.cmp = 'eq'; sync(); });
    cmp.addEventListener('change', () => { spec.cmp = cmp.value; sync(); });
    path.addEventListener('input', () => { spec.path = path.value; });
    exp.addEventListener('input', () => { spec.expected = exp.value; });
    sync();

    function collect() { return { id: existing ? existing.id : undefined, kind: 'basic', title: title.value, spec: { source: spec.source, cmp: spec.cmp, path: path.value, expected: exp.value, level: lvl.value }, notify: notifyCb.checked, debounce: parseInt(deb.value, 10) || 1 }; }
    const dry = m.querySelector('#sm-dry');
    m.querySelector('#sm-b-test').addEventListener('click', async () => {
      dry.className = 'sm-dry busy'; dry.textContent = 'Проверяю на живом ответе…';
      const r = await lite.sitemon.dryRun({ url: target.url, headers: target.headers, render: target.render, insecureTls: target.insecureTls, check: collect() });
      renderDry(dry, r);
    });
    m.querySelector('#sm-b-cancel').addEventListener('click', close);
    m.querySelector('#sm-b-save').addEventListener('click', async () => {
      const c = collect();
      const r = existing ? await lite.sitemon.editCheck(target.id, existing.id, { title: c.title, spec: c.spec, notify: c.notify, debounce: c.debounce }) : await lite.sitemon.addCheck(target.id, c);
      if (r && r.ok) { close(); reload(); } else toast((r && r.error) || 'Не удалось сохранить', { kind: 'err' });
    });
    setTimeout(() => title.focus(), 30);
  }

  // ── чат кастомного чека ─────────────────────────────────────────────────────────────────────────────
  function customCheckDialog(target, existing) {
    const disposers = [];
    let sample = null, busy = null;
    const transcript = [];
    const { m, close } = makeModal('<h2>Кастомный чек — чат с агентом</h2>', () => {
      if (busy) { try { busy.abort(); } catch (_) {} busy = null; }
      for (const d of disposers) { try { d(); } catch (_) {} }
    });
    m.classList.add('sm-modal', 'sm-ai-modal'); addCloseX(m, close);
    const wrap = el('div', 'sm-ai');
    const left = el('div', 'sm-ai-left');
    const right = el('div', 'sm-ai-right');

    // ── ЛЕВО: цель + сэмпл (типизированный вьюер) + редактор предиката + предпросмотр ──
    const urlBar = el('div', 'sm-ai-urlbar');
    const urlChip = el('span', 'sm-ai-url', target.url); urlChip.title = target.url; urlBar.appendChild(urlChip);
    const smpBtn = el('button', 'btn sm', 'Обновить сэмпл'); urlBar.appendChild(smpBtn);
    left.appendChild(urlBar);
    left.appendChild(el('div', 'sm-l', 'Живой сэмпл ответа URL'));
    const smpView = el('div', 'sm-ai-sampleview'); left.appendChild(smpView);
    const codeWrap = el('div', 'sm-ai-code');
    codeWrap.appendChild(el('div', 'sm-l', 'Код предиката (правится вручную; агент обновляет его)'));
    const codeHost = el('div', 'sm-code-host'); codeWrap.appendChild(codeHost);
    let predEd = null, pendingCode = (existing && existing.code) ? existing.code : '';
    ensureLanguage('check.js').then((support) => { predEd = createCodeEditor(codeHost, { doc: pendingCode, language: support }); disposers.push(() => { try { predEd.destroy(); } catch (_) {} }); });
    const getCode = () => (predEd ? predEd.getValue() : pendingCode).trim();
    const setCode = (code) => { pendingCode = code; if (predEd) predEd.view.dispatch({ changes: { from: 0, to: predEd.view.state.doc.length, insert: code } }); };
    const titleRow = el('div', 'sm-ai-titlerow');
    const titleIn = el('input', 'sm-in'); titleIn.placeholder = 'Заголовок чека'; titleIn.value = existing ? (existing.title || '') : '';
    titleRow.appendChild(el('span', 'sm-l', 'Заголовок')); titleRow.appendChild(titleIn); codeWrap.appendChild(titleRow);
    const dry = el('div', 'sm-dry'); codeWrap.appendChild(dry);
    const codeActs = el('div', 'sm-ai-codeacts');
    const testBtn = el('button', 'btn sm', 'Проверить'); const saveBtn = el('button', 'btn primary sm', existing ? 'Сохранить чек' : 'Добавить чек');
    codeActs.append(testBtn, saveBtn); codeWrap.appendChild(codeActs);
    left.appendChild(codeWrap);

    // ── ПРАВО: живой диалог с агентом ──
    const chatHead = el('div', 'sm-ai-chathead');
    chatHead.appendChild(el('span', 'sm-ai-chattitle', 'Диалог с агентом'));
    const agSel = el('select', 'sm-in sm-ai-agent'); for (const o of agentOptions()) { const opt = el('option', null, o.label); opt.value = o.id; agSel.appendChild(opt); }
    agSel.value = smUi().aiAgent || 'claude'; if (agSel.selectedIndex < 0) agSel.selectedIndex = 0;
    agSel.addEventListener('change', () => saveUi({ aiAgent: agSel.value }));
    chatHead.appendChild(agSel);
    right.appendChild(chatHead);
    const log = el('div', 'sm-ai-log'); right.appendChild(log);
    const emptyHint = el('div', 'sm-ai-empty', 'Опишите, что проверять на этом URL. Агент увидит живой сэмпл (слева) и напишет предикат — его код появится в редакторе слева. Дальше уточняйте прямо здесь: «сделай порог 4000», «жёлтый если >80%, красный если >95%» — диалог продолжается, код обновляется.');
    const inputRow = el('div', 'sm-ai-input');
    const ta = el('textarea', 'sm-in sm-ai-ta'); ta.rows = 2; ta.placeholder = 'Опишите условие или уточнение… Enter — отправить, Shift+Enter — новая строка';
    const sendBtn = el('button', 'btn primary sm', 'Отправить'); inputRow.append(ta, sendBtn); right.appendChild(inputRow);

    wrap.append(left, right);
    m.appendChild(wrap);

    function renderLog() {
      log.textContent = '';
      if (!transcript.length) { log.appendChild(emptyHint); return; }
      for (const msg of transcript) {
        const b = el('div', 'sm-ai-msg ' + msg.role);
        if (msg.role === 'assistant' && msg.pending && !msg.text) { b.classList.add('pending'); b.appendChild(el('span', 'sm-ai-thinking', 'агент думает')); const t = el('span', 'sm-ai-typing'); t.append(el('i'), el('i'), el('i')); b.appendChild(t); }
        else b.textContent = msg.text || '';
        log.appendChild(b);
      }
      log.scrollTop = log.scrollHeight;
    }
    renderLog();

    async function loadSample() {
      smpView.textContent = ''; smpView.appendChild(el('div', 'sm-ai-empty', 'загрузка сэмпла…'));
      const r = await lite.sitemon.sample({ url: target.url, headers: target.headers, render: target.render, insecureTls: target.insecureTls });
      sample = (r && r.ok) ? r : null;
      renderSample(smpView, r, disposers);
    }
    smpBtn.addEventListener('click', loadSample);

    function buildPrompt(userText) {
      let s = SYSTEM_PROMPT + '\n\nURL: ' + target.url + '\n';
      if (sample) {
        s += '\n=== ЖИВОЙ СЭМПЛ ОТВЕТА ===\nHTTP ' + sample.status + (sample.ctype ? ' · ' + sample.ctype : '') + '\n';
        if (sample.isJson) s += 'JSON:\n' + JSON.stringify(sample.json, null, 2).slice(0, 8000) + '\n';
        else s += 'Тело:\n' + (sample.body || '').slice(0, 8000) + '\n';
        if (sample.rendered && sample.renderedText) s += 'Видимый текст (рендер):\n' + sample.renderedText.slice(0, 4000) + '\n';
        s += '=== КОНЕЦ СЭМПЛА ===\n';
      } else s += '(живой сэмпл не загружен — пиши по описанию, опираясь на здравый смысл)\n';
      const cur = getCode(); if (cur) s += '\n=== ТЕКУЩИЙ КОД ЧЕКА (при правке — измени его) ===\n```js\n' + cur + '\n```\n';
      s += '\n=== ДИАЛОГ ===\n';
      for (const msg of transcript) s += (msg.role === 'user' ? 'ПОЛЬЗОВАТЕЛЬ: ' : 'АГЕНТ: ') + msg.text + '\n';
      s += 'ПОЛЬЗОВАТЕЛЬ: ' + userText + '\nАГЕНТ: ';
      return s;
    }
    function extractCode(text) { const fence = /```(?:js|javascript)?\s*\n?([\s\S]*?)```/i.exec(text || ''); return fence ? fence[1].trim() : ''; }
    function extractTitle(text) { const mm = /Заголовок\s*[:：]\s*(.+)/i.exec(text || ''); return mm ? mm[1].trim().replace(/[«»"'`]/g, '').slice(0, 120) : ''; }
    const stopBusy = () => { busy = null; sendBtn.textContent = 'Отправить'; sendBtn.classList.remove('busy'); };

    async function send() {
      const userText = ta.value.trim(); if (!userText || busy) return;
      if (!sample) await loadSample();
      ta.value = '';
      const prompt = buildPrompt(userText);            // строим ДО добавления в транскрипт (иначе дубль)
      transcript.push({ role: 'user', text: userText });
      const asst = { role: 'assistant', text: '', pending: true }; transcript.push(asst); renderLog();
      sendBtn.textContent = 'Стоп'; sendBtn.classList.add('busy');
      busy = runAgent(agSel.value, prompt, {
        onData: (chunk) => { asst.pending = false; asst.text += chunk; renderLog(); },
        onDone: () => { stopBusy(); const code = extractCode(asst.text); if (code) { setCode(code); const t = extractTitle(asst.text); if (t && !titleIn.value.trim()) titleIn.value = t; runDry(); } },
        onError: (err) => { stopBusy(); asst.pending = false; asst.text += (asst.text ? '\n' : '') + '⚠️ ' + err; renderLog(); toast(err, { kind: 'err' }); },
      });
    }
    sendBtn.addEventListener('click', () => { if (busy) { busy.abort(); stopBusy(); return; } send(); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });

    async function runDry() {
      const code = getCode(); if (!code) { dry.className = 'sm-dry'; dry.textContent = ''; return; }
      dry.className = 'sm-dry busy'; dry.textContent = 'Проверяю на живом ответе…';
      const r = await lite.sitemon.dryRun({ url: target.url, headers: target.headers, render: target.render, insecureTls: target.insecureTls, check: { kind: 'custom', code, title: titleIn.value || 'Кастомный чек' } });
      renderDry(dry, r);
    }
    testBtn.addEventListener('click', runDry);
    saveBtn.addEventListener('click', async () => {
      const code = getCode(); if (!code) { toast('Нет кода предиката', { kind: 'err' }); return; }
      const title = titleIn.value.trim() || 'Кастомный чек';
      const r = existing
        ? await lite.sitemon.editCheck(target.id, existing.id, { title, code })
        : await lite.sitemon.addCheck(target.id, { kind: 'custom', title, code, meta: { intent: transcript.filter((x) => x.role === 'user').map((x) => x.text).join(' · ').slice(0, 300) } });
      if (r && r.ok) { close(); reload(); } else toast((r && r.error) || 'Не удалось сохранить', { kind: 'err' });
    });
    setTimeout(() => { loadSample(); ta.focus(); }, 30);
  }

  // ── спарклайн истории чека ──────────────────────────────────────────────────────────────────────────
  function sparkline(hist) {
    const bar = el('div', 'sm-hist');
    const arr = (hist || []).slice(-40);
    for (const h of arr) { const s = h.s || 'unknown'; const c = el('span', 'sm-tick ' + s); c.title = new Date(h.t).toLocaleTimeString() + ' · ' + stateLabel(s) + (h.v != null ? ' · ' + h.v : ''); bar.appendChild(c); }
    return bar;
  }

  // ── рамка одного чека ───────────────────────────────────────────────────────────────────────────────
  function checkFrame(target, c) {
    const st = c.state || 'unknown';
    const fr = el('div', 'sm-check-fr ' + st);
    const top = el('div', 'sm-cf-top');
    top.appendChild(el('span', 'sm-dot ' + st));
    const t = el('div', 'sm-cf-title');
    t.appendChild(el('span', 'sm-cf-name', c.title || 'Чек'));
    t.appendChild(el('span', 'sm-cf-kind ' + (c.kind === 'custom' ? 'custom' : 'basic'), c.kind === 'custom' ? 'агент' : 'базовый'));
    top.appendChild(t);
    const acts = el('div', 'sm-acts');
    const chk = iconBtn('icon-btn', 'refresh', 'Проверить сейчас', 13); chk.addEventListener('click', () => lite.sitemon.checkNow(target.id)); acts.appendChild(chk);
    const ed = iconBtn('icon-btn', 'pencil', 'Изменить', 13); ed.addEventListener('click', () => (c.kind === 'custom' ? customCheckDialog(target, c) : basicCheckDialog(target, c))); acts.appendChild(ed);
    const rm = iconBtn('icon-btn', 'trash', 'Удалить чек', 13); rm.addEventListener('click', () => showConfirm('Удалить чек?', '«' + (c.title || 'Чек') + '» перестанет отслеживаться.', 'Удалить', async () => { await lite.sitemon.removeCheck(target.id, c.id); reload(); })); acts.appendChild(rm);
    top.appendChild(acts);
    fr.appendChild(top);

    const stat = el('div', 'sm-cf-stat');
    stat.appendChild(el('span', 'sm-state ' + st, stateLabel(st)));
    if (st === 'error') stat.appendChild(el('span', 'sm-err', c.error || 'ошибка'));
    else if (c.value != null && c.value !== '') stat.appendChild(el('span', 'sm-cf-val', String(c.value)));
    stat.appendChild(el('span', 'sm-meta', fmtAgo(c.checkedAt)));
    fr.appendChild(stat);
    fr.appendChild(sparkline(c.history));
    return fr;
  }

  // ── карточка цели ───────────────────────────────────────────────────────────────────────────────────
  function targetCard(t) {
    const ru = rollup(t.checks);
    const card = el('div', 'sm-card ' + ru.state);
    const top = el('div', 'sm-top');
    top.appendChild(el('span', 'sm-dot ' + ru.state));
    const main = el('div', 'sm-main');
    main.appendChild(el('span', 'sm-name', t.name || t.url));
    main.appendChild(el('span', 'sm-url', t.url + (t.render ? ' · рендер' : '')));
    top.appendChild(main);
    const acts = el('div', 'sm-acts');
    const chk = iconBtn('icon-btn', 'refresh', 'Проверить все чеки', 14); chk.addEventListener('click', () => lite.sitemon.checkNow(t.id)); acts.appendChild(chk);
    const addc = el('button', 'icon-btn sm-addcheck'); addc.title = 'Добавить чек'; addc.textContent = '＋'; addc.addEventListener('click', () => checkChooser(t)); acts.appendChild(addc);
    const ed = iconBtn('icon-btn', 'pencil', 'Настройки цели', 14); ed.addEventListener('click', () => targetDialog(t)); acts.appendChild(ed);
    const rm = iconBtn('icon-btn', 'trash', 'Удалить цель', 14); rm.addEventListener('click', () => showConfirm('Удалить цель?', '«' + (t.name || t.url) + '» и все её чеки перестанут отслеживаться.', 'Удалить', async () => { await lite.sitemon.removeTarget(t.id); reload(); })); acts.appendChild(rm);
    top.appendChild(acts);
    card.appendChild(top);

    const meta = el('div', 'sm-card-meta');
    const parts = [ru.n + ' ' + plural(ru.n, 'чек', 'чека', 'чеков')];
    if (ru.trig) parts.push('🔴 ' + ru.trig); if (ru.warn) parts.push('🟡 ' + ru.warn); if (ru.info) parts.push('🔵 ' + ru.info); if (ru.err) parts.push('⚙ ' + ru.err); if (ru.ok) parts.push('🟢 ' + ru.ok);
    parts.push('кажд. ' + fmtInt(t.intervalSec));
    meta.appendChild(el('span', null, parts.join(' · ')));
    card.appendChild(meta);

    const list = el('div', 'sm-checks');
    if (!t.checks || !t.checks.length) { const e = el('div', 'sm-nochecks'); e.appendChild(el('span', null, 'Чеков нет. ')); const a = el('button', 'sm-link', 'Добавить чек'); a.addEventListener('click', () => checkChooser(t)); e.appendChild(a); list.appendChild(e); }
    else { const order = t.checks.slice().sort((a, b) => rank(a.state) - rank(b.state)); for (const c of order) list.appendChild(checkFrame(t, c)); }
    card.appendChild(list);
    return card;
  }

  // ── модалка-справка «О модуле» ──────────────────────────────────────────────────────────────────────
  function helpModal() {
    const { m, close } = makeModal('<h2>О модуле «Мониторинг сайтов»</h2><div class="sm-help"></div><div class="modal-actions"><button class="btn primary" id="sm-help-ok">Понятно</button></div>');
    m.classList.add('sm-modal'); addCloseX(m, close);
    const h = m.querySelector('.sm-help');
    const p = (html) => { const d = el('div', 'sm-help-p'); d.innerHTML = html; h.appendChild(d); };
    p('<b>Что это.</b> Следит за сайтами и API. Единица — <b>цель</b> (URL + интервал/заголовки), на неё вешается сколько угодно <b>чеков</b> (статус-рамок). Один чек = одно условие над URL.');
    p('<b>Базовый чек</b> — из полей: HTTP-код, поле JSON, текст на странице, число/порог, «изменилось». Без ИИ.');
    p('<b>Кастомный чек</b> — опишите словами, и агент напишет мини-парсер под этот URL (правится в диалоге и вручную; исполняется в песочнице).');
    p('<b>Статусы (цвета рамки):</b> 🟢 в норме · 🟡 внимание · 🔴 тревога (о ней приходит уведомление) · 🔵 инфо. Кастомный чек может отдавать разные статусы по данным (пороги).');
    p('<b>Отображение.</b> «Блоки» — карточки со статус-рамками и мини-историей. «Графики» — статистика за месяц: аптайм, средняя задержка, дни с тревогой.');
    const bg = el('div', 'sm-help-note');
    bg.innerHTML = '<b>Почему работает, даже если закрыть окно.</b> Проверки выполняет <b>главный процесс</b> редактора в фоне по таймеру каждой цели, а это окно — только просмотр результата. Поэтому закрытие окна модуля <b>не останавливает</b> мониторинг и уведомления — они идут, пока запущен сам редактор. Мониторинг прекращается только при полном выходе из редактора.';
    h.appendChild(bg);
    m.querySelector('#sm-help-ok').addEventListener('click', close);
  }

  // ── карточка цели в режиме «Графики» (статистика за месяц) ───────────────────────────────────────────
  function chartCard(t) {
    const map = aggDays(t.checks);
    const sum = statSummary([...map.values()]);
    const ru = rollup(t.checks);
    const card = el('div', 'sm-chart-card ' + ru.state);
    const head = el('div', 'sm-chart-head');
    head.appendChild(el('span', 'sm-dot ' + ru.state));
    const main = el('div', 'sm-main'); main.appendChild(el('span', 'sm-name', t.name || t.url)); main.appendChild(el('span', 'sm-url', t.url + (t.render ? ' · рендер' : ''))); head.appendChild(main);
    const chk = iconBtn('icon-btn', 'refresh', 'Проверить сейчас', 14); chk.addEventListener('click', () => lite.sitemon.checkNow(t.id)); head.appendChild(chk);
    const ed = iconBtn('icon-btn', 'pencil', 'Настройки цели', 14); ed.addEventListener('click', () => targetDialog(t)); head.appendChild(ed);
    card.appendChild(head);

    const tiles = el('div', 'sm-tiles');
    const upCls = sum.uptime == null ? '' : sum.uptime >= 99 ? 'ok' : sum.uptime >= 95 ? 'warn' : 'triggered';
    tiles.appendChild(statTile(sum.uptime == null ? '—' : (sum.uptime >= 99.95 ? sum.uptime.toFixed(2) : sum.uptime.toFixed(1)) + '%', 'Аптайм (30д)', upCls));
    tiles.appendChild(statTile(sum.avgMs == null ? '—' : sum.avgMs + ' мс', 'Ср. задержка'));
    tiles.appendChild(statTile(String(sum.downDays), 'Дней с тревогой', sum.downDays ? 'triggered' : ''));
    tiles.appendChild(statTile(sum.checks >= 1000 ? (sum.checks / 1000).toFixed(1) + 'k' : String(sum.checks), 'Проверок'));
    card.appendChild(tiles);

    card.appendChild(el('div', 'sm-chart-lbl', 'Аптайм по дням (последние 30)'));
    card.appendChild(uptimeStrip(map));
    const line = latencyLine(map); if (line) { card.appendChild(el('div', 'sm-chart-lbl', 'Средняя задержка по дням')); card.appendChild(line); }

    if ((t.checks || []).length) {
      const cl = el('div', 'sm-chart-checks');
      for (const c of t.checks) { const cs = statSummary(c.stats || []); const row = el('div', 'sm-chk-row'); row.appendChild(el('span', 'sm-dot ' + (c.state || 'unknown'))); row.appendChild(el('span', 'sm-chk-name', c.title || 'Чек')); row.appendChild(el('span', 'sm-chk-up', cs.uptime == null ? 'нет данных' : 'аптайм ' + cs.uptime.toFixed(1) + '%')); cl.appendChild(row); }
      card.appendChild(cl);
    }
    if (sum.checks === 0) card.appendChild(el('div', 'sm-chart-nodata', 'Статистика копится по мере проверок — загляните позже.'));
    return card;
  }

  function render() {
    if (!body) return; body.textContent = '';
    const head = el('div', 'sm-head');
    head.appendChild(el('span', 'sm-h-title', 'Мониторинг сайтов'));
    const seg = el('div', 'sm-seg');
    const bBlk = el('button', 'sm-seg-b' + (viewMode === 'blocks' ? ' on' : ''), 'Блоки');
    const bCh = el('button', 'sm-seg-b' + (viewMode === 'charts' ? ' on' : ''), 'Графики');
    bBlk.addEventListener('click', () => { if (viewMode !== 'blocks') { viewMode = 'blocks'; saveUi({ viewMode }); render(); } });
    bCh.addEventListener('click', () => { if (viewMode !== 'charts') { viewMode = 'charts'; saveUi({ viewMode }); render(); } });
    seg.append(bBlk, bCh); head.appendChild(seg);
    const helpB = el('button', 'icon-btn sm-help-btn'); helpB.textContent = '?'; helpB.title = 'О модуле'; helpB.addEventListener('click', helpModal); head.appendChild(helpB);
    const all = el('button', 'btn sm', 'Проверить все'); all.disabled = !targets.length; all.addEventListener('click', () => lite.sitemon.checkNow()); head.appendChild(all);
    const add = el('button', 'btn primary sm', '＋ URL'); add.addEventListener('click', () => targetDialog(null)); head.appendChild(add);
    body.appendChild(head);

    if (!targets.length) { body.appendChild(el('div', 'sm-empty', 'Целей пока нет. Нажмите «＋ URL» — добавьте сайт/эндпоинт, а затем повесьте на него чеки: доступность, поле JSON, «изменилось», текст или кастомный (агент напишет мини-парсер).')); return; }
    let trig = 0; for (const t of targets) if (rollup(t.checks).state === 'triggered') trig++;
    if (trig) { const b = el('div', 'sm-banner'); b.appendChild(icon('warning', 15)); b.appendChild(el('span', null, `Сработали чеки на ${trig} из ${targets.length}`)); body.appendChild(b); }
    const order = targets.slice().sort((a, b) => rank(rollup(a.checks).state) - rank(rollup(b.checks).state) || (a.name || a.url).localeCompare(b.name || b.url));
    if (viewMode === 'charts') { const list = el('div', 'sm-charts'); for (const t of order) list.appendChild(chartCard(t)); body.appendChild(list); }
    else { const list = el('div', 'sm-list'); for (const t of order) list.appendChild(targetCard(t)); body.appendChild(list); }
  }

  return {
    setOpen(open) {
      const pane = $('#sitemon-pane'); if (pane) pane.classList.toggle('hidden', !open);
      if (open) { reload(); if (!unsub) unsub = lite.sitemon.onUpdate((list) => { targets = list || []; render(); }); }
    },
    isOpen: () => true,
    addSite: () => targetDialog(null),
    checkAll: () => lite.sitemon.checkNow(),
  };
}
