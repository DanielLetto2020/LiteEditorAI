// LiteEditor — модуль «WEB/SEO аудит»: самостоятельный анализатор сайтов (правый слот).
// НЕ привязан к проектам — системная панель (как Контейнеры/БД). Свой список сайтов + история
// аудитов на каждый сайт. Два движка бэкенда:
//   • seo:scan   — быстрый проход на Node (заголовки/безопасность/SEO из сырого HTML/robots/TLS/DNS/WHOIS/гео);
//   • seo:render — глубокий аудит в скрытом Chromium (отрендеренный DOM, метрики, сеть, скриншоты, битые ссылки).
// Результаты сливаются в один отчёт; лёгкие снимки (оценки/счётчики/метрики) сохраняются в историю
// (скриншоты в историю НЕ пишем — только в памяти текущей сессии). Вкладки:
//   Обзор · Безопасность · SEO · Производительность · Сеть/Домен · История.
// Изоляция как у audit.js: всё из ядра — только через host; UI — из ui.js.
// host: { layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels, STORE, persist }
import { el, icon, iconBtn, toast } from '../ui.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

const TABS = [
  { id: 'overview', label: 'Обзор', icon: 'grid' },
  { id: 'security', label: 'Безопасность', icon: 'check' },
  { id: 'seo', label: 'SEO', icon: 'search' },
  { id: 'perf', label: 'Скорость', icon: 'chevron-up' },
  { id: 'network', label: 'Сеть/Домен', icon: 'globe' },
  { id: 'history', label: 'История', icon: 'note' },
];
const SEV_RANK = { crit: 0, warn: 1, info: 2, ok: 3 };
const SEV_LABEL = { crit: 'критично', warn: 'важно', info: 'инфо', ok: 'ок' };
const SNAP_CAP = 12;

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' Б';
  const u = ['КБ', 'МБ', 'ГБ']; let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
}
function fmtMs(ms) { return ms == null ? '—' : (ms >= 1000 ? (ms / 1000).toFixed(2) + ' с' : Math.round(ms) + ' мс'); }
function hostOf(url) { try { return new URL(url).host; } catch { return url; } }

// Оценка скорости из метрик Core Web Vitals + веса.
function perfScore(p, net) {
  if (!p) return null;
  let s = 100;
  if (p.lcp > 4000) s -= 30; else if (p.lcp > 2500) s -= 15;
  if (p.cls > 0.25) s -= 25; else if (p.cls > 0.1) s -= 12;
  if (p.load > 5000) s -= 20; else if (p.load > 3000) s -= 10;
  if (net && net.bytes > 3 * 1024 * 1024) s -= 10;
  if (net && net.uncompressed > 100 * 1024) s -= 8;
  return Math.max(0, Math.min(100, s));
}

// Слить быстрый скан и глубокий рендер в один отчёт + добрать находки из рендера.
function buildResult(scan, render) {
  const r = { ...scan };
  r.render = render && render.ok ? render : null;
  r.renderError = render && !render.ok ? render.error : null;
  const extra = [];
  if (r.render) {
    const bl = r.render.brokenLinks;
    if (bl && bl.broken.length) extra.push({ cat: 'SEO', sev: 'warn', title: bl.broken.length + ' битых ссылок', advice: 'Ведут на 4xx/5xx — см. вкладку SEO.' });
    const errs = (r.render.console || []).filter((c) => c.level >= 3).length;
    if (errs) extra.push({ cat: 'Скорость', sev: 'info', title: errs + ' ошибок в консоли', advice: 'JS-ошибки на странице — вкладка Скорость.' });
    if (r.render.network && r.render.network.mixed) extra.push({ cat: 'Безопасность', sev: 'warn', title: 'Mixed content (' + r.render.network.mixed + ')', advice: 'HTTP-ресурсы на HTTPS — браузер их блокирует.' });
    const p = r.render.perf;
    if (p) {
      if (p.lcp > 4000) extra.push({ cat: 'Скорость', sev: 'warn', title: 'LCP ' + (p.lcp / 1000).toFixed(1) + ' с — медленно', advice: 'Цель LCP < 2.5 с.' });
      else if (p.lcp > 2500) extra.push({ cat: 'Скорость', sev: 'info', title: 'LCP ' + (p.lcp / 1000).toFixed(1) + ' с', advice: 'Цель LCP < 2.5 с.' });
      if (p.cls > 0.25) extra.push({ cat: 'Скорость', sev: 'warn', title: 'CLS ' + p.cls + ' — вёрстка скачет', advice: 'Цель CLS < 0.1.' });
      else if (p.cls > 0.1) extra.push({ cat: 'Скорость', sev: 'info', title: 'CLS ' + p.cls, advice: 'Цель CLS < 0.1.' });
    }
    const dom = r.render.dom;
    if (dom && dom.imgNoDim > 0) extra.push({ cat: 'Скорость', sev: 'info', title: dom.imgNoDim + ' картинок без width/height', advice: 'Задавайте размеры — меньше CLS.' });
  }
  r.findings = [...(scan.findings || []), ...extra];
  r.scores = {
    security: scan.scores ? scan.scores.security : null,
    seo: scan.scores ? scan.scores.seo : null,
    perf: r.render ? perfScore(r.render.perf, r.render.network) : null,
  };
  return r;
}
// Лёгкий снимок для истории (без скриншотов).
function snapOf(result) {
  const p = result.render && result.render.perf;
  return {
    at: result.scannedAt || '',
    status: result.fetch && result.fetch.ok ? result.fetch.status : 0,
    scores: result.scores || {},
    perf: p ? { lcp: p.lcp, cls: p.cls, load: p.load } : null,
    bytes: result.render && result.render.network ? result.render.network.bytes : null,
  };
}

export function initSeo(host) {
  const { layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels, STORE, persist } = host;

  let seoOpen = false;
  let tab = 'overview';
  let seoView = 'rendered';                                  // 'rendered' | 'raw' — источник SEO-данных
  const sites = Array.isArray(STORE.seoSites) ? STORE.seoSites.slice() : []; // [{url, snaps:[]}]
  let selectedUrl = sites.length ? sites[0].url : null;
  const results = new Map();                                 // url → полный результат (в памяти, со скриншотами)
  let scanSeq = 0;

  function saveSites() { persist('seoSites', sites); }
  function siteOf(url) { return sites.find((s) => s.url === url); }
  function curSite() { return selectedUrl ? siteOf(selectedUrl) : null; }
  function curResult() { return selectedUrl ? results.get(selectedUrl) : null; }

  function addSite(raw) {
    const url = String(raw || '').trim();
    if (!url) return;
    if (!siteOf(url)) { sites.unshift({ url, snaps: [] }); saveSites(); }
    selectedUrl = url; tab = 'overview';
    renderBody();
    scan();
  }
  function removeSite(url) {
    const i = sites.findIndex((s) => s.url === url);
    if (i < 0) return;
    sites.splice(i, 1); results.delete(url); saveSites();
    if (selectedUrl === url) selectedUrl = sites.length ? sites[0].url : null;
    renderBody();
  }

  // ---------------- скан: поэтапно (быстрый scan → render → links), UI дорисовывается по мере прихода ----------------
  function scan() {
    const site = curSite();
    if (!site) { toast('Добавьте сайт'); return; }
    const url = site.url;
    const seq = ++scanSeq;
    const prog = { scanRes: undefined, renderRes: undefined, linksRes: undefined, snapped: false };
    results.set(url, { partial: true, url });          // плейсхолдер → спиннер «Сканирую…»
    renderBody();

    // Пересборка результата из того, что уже пришло; снимок в историю — только когда всё готово.
    const compose = () => {
      if (seq !== scanSeq) return;
      const sc = prog.scanRes;
      if (sc === undefined) return;                    // базовый скан ещё не пришёл — рисовать нечего
      if (!sc || sc.error) { results.set(url, sc && sc.error ? sc : { error: 'Пустой ответ' }); renderBody(); return; }
      if (sc.fetch && !sc.fetch.ok) { results.set(url, sc); renderBody(); return; }
      const renderDone = prog.renderRes !== undefined;
      const rr = renderDone ? prog.renderRes : null;
      let renderForBuild = null;
      if (rr && rr.ok) renderForBuild = (prog.linksRes !== undefined) ? { ...rr, brokenLinks: prog.linksRes } : rr;
      else if (renderDone) renderForBuild = rr;        // ok:false → buildResult сохранит renderError
      const result = buildResult(sc, renderForBuild);
      const linksPending = !!(rr && rr.ok && rr.dom && rr.dom.links && prog.linksRes === undefined);
      result.progress = { render: !renderDone, links: linksPending };
      results.set(url, result);
      if (renderDone && !linksPending && !prog.snapped) {
        prog.snapped = true;
        site.snaps = site.snaps || [];
        site.snaps.unshift(snapOf(result));
        site.snaps = site.snaps.slice(0, SNAP_CAP);
        saveSites();
      }
      renderBody();
    };

    // Этап 1 — быстрый скан (Node).
    lite.seo.scan(url)
      .then((r) => { if (seq !== scanSeq) return; prog.scanRes = r; compose(); })
      .catch((e) => { if (seq !== scanSeq) return; prog.scanRes = { error: String((e && e.message) || e) }; compose(); });

    // Этап 2 — рендер (скрытый Chromium); этап 3 — проверка ссылок из отрендеренного DOM.
    lite.seo.render(url)
      .then((r) => {
        if (seq !== scanSeq) return;
        prog.renderRes = r || { ok: false, error: 'нет ответа' };
        compose();
        const links = r && r.ok && r.dom && r.dom.links;
        if (links) {
          lite.seo.links([...(links.internal || []), ...(links.external || [])], r.url)
            .then((lr) => { if (seq !== scanSeq) return; prog.linksRes = lr || { checked: 0, broken: [] }; compose(); })
            .catch(() => { if (seq !== scanSeq) return; prog.linksRes = { checked: 0, broken: [] }; compose(); });
        }
      })
      .catch((e) => { if (seq !== scanSeq) return; prog.renderRes = { ok: false, error: String((e && e.message) || e) }; compose(); });
  }

  async function findDevServers() {
    const r = await lite.seo.devServers().catch(() => null);
    const ports = (r && r.ports) || [];
    if (!ports.length) { toast('Локальные dev-серверы не найдены'); return; }
    addSite('http://localhost:' + ports[0]);
    if (ports.length > 1) toast('Найдены порты: ' + ports.join(', '));
  }

  // ---------------- рендер ----------------
  function renderBody() {
    const body = $('#seo-body');
    if (!body) return;
    const title = $('#seo-proj');
    if (title) title.textContent = selectedUrl ? ('WEB/SEO — ' + hostOf(selectedUrl)) : 'WEB/SEO аудит';

    body.innerHTML = '';
    body.appendChild(renderControls());
    if (sites.length) body.appendChild(renderSiteBar());

    const content = el('div', 'seo-content');
    body.appendChild(content);

    if (!selectedUrl) { content.appendChild(el('div', 'seo-empty', 'Добавьте сайт сверху: впишите адрес (или 🔍 найдите локальный dev-сервер) и нажмите «Аудит».\nМожно вести несколько сайтов — у каждого своя история.')); return; }

    body.insertBefore(renderTabs(), content);

    const data = curResult();
    if (!data) { content.appendChild(renderFromHistory()); return; }
    if (data.error) { content.appendChild(el('div', 'seo-empty seo-err', 'Ошибка: ' + data.error)); return; }
    if (!data.fetch) { content.appendChild(el('div', 'seo-empty', 'Сканирую сайт…')); return; }   // базовый скан ещё идёт
    if (!data.fetch.ok) { content.appendChild(el('div', 'seo-empty seo-err', 'Сайт недоступен: ' + data.fetch.error)); return; }

    // Плашка прогресса фоновых этапов (рендер/ссылки) — данные при этом уже видны.
    if (data.progress && (data.progress.render || data.progress.links)) {
      const stages = [data.progress.render ? 'скриншоты и метрики' : null, data.progress.links ? 'проверка ссылок' : null].filter(Boolean).join(', ');
      content.appendChild(el('div', 'seo-prog', '⏳ Глубокий аудит идёт: ' + stages + '…'));
    }

    if (tab === 'overview') renderOverview(content, data);
    else if (tab === 'security') renderSecurity(content, data);
    else if (tab === 'seo') renderSeoTab(content, data);
    else if (tab === 'perf') renderPerf(content, data);
    else if (tab === 'network') renderNetwork(content, data);
    else if (tab === 'history') renderHistory(content);
  }

  // Если детального результата в памяти нет (после перезапуска) — показать сводку из последнего снимка.
  function renderFromHistory() {
    const site = curSite();
    const wrap = el('div', null);
    if (site && site.snaps && site.snaps.length) {
      const s = site.snaps[0];
      wrap.appendChild(el('div', 'seo-h', 'Последний аудит: ' + (s.at ? s.at.slice(0, 16).replace('T', ' ') : '—')));
      const cards = el('div', 'seo-scores');
      cards.appendChild(scoreCard('Безопасность', s.scores.security));
      cards.appendChild(scoreCard('SEO', s.scores.seo));
      cards.appendChild(scoreCard('Скорость', s.scores.perf));
      wrap.appendChild(cards);
      wrap.appendChild(el('div', 'seo-foot', 'Детали (скриншоты, заголовки, ссылки) живут до перезапуска. Нажмите «Аудит», чтобы пересканировать.'));
    } else {
      wrap.appendChild(el('div', 'seo-empty', 'Нажмите «Аудит», чтобы просканировать сайт.'));
    }
    const b = el('button', 'seo-scan'); b.append(icon('refresh', 14), el('span', null, 'Аудит'));
    b.onclick = () => scan();
    wrap.appendChild(b);
    return wrap;
  }

  function renderControls() {
    const bar = el('div', 'seo-controls');
    const input = el('input', 'seo-url');
    input.type = 'text';
    input.placeholder = 'localhost:5173  или  https://example.com';
    input.spellcheck = false;
    input.onkeydown = (e) => { if (e.key === 'Enter' && input.value.trim()) { addSite(input.value); input.value = ''; } };
    bar.appendChild(input);
    const dev = iconBtn('seo-iconbtn', 'search', 'Найти локальные dev-серверы', 15);
    dev.onclick = () => findDevServers();
    bar.appendChild(dev);
    const addBtn = el('button', 'seo-scan');
    addBtn.append(icon('refresh', 14), el('span', null, 'Аудит'));
    addBtn.title = 'Добавить сайт из поля и просканировать (или пересканировать выбранный)';
    addBtn.onclick = () => { if (input.value.trim()) { addSite(input.value); input.value = ''; } else if (selectedUrl) scan(); else toast('Впишите адрес сайта'); };
    bar.appendChild(addBtn);
    return bar;
  }

  function renderSiteBar() {
    const row = el('div', 'seo-sitebar');
    for (const s of sites) {
      const chip = el('div', 'seo-sitechip' + (s.url === selectedUrl ? ' active' : ''));
      const lbl = el('span', 'seo-sitelbl', hostOf(s.url));
      lbl.title = s.url;
      lbl.onclick = () => { selectedUrl = s.url; tab = 'overview'; renderBody(); };
      chip.appendChild(lbl);
      const x = iconBtn('seo-sitex', 'x', 'Убрать сайт', 12);
      x.onclick = (e) => { e.stopPropagation(); removeSite(s.url); };
      chip.appendChild(x);
      row.appendChild(chip);
    }
    return row;
  }

  function renderTabs() {
    const row = el('div', 'seo-tabs');
    for (const t of TABS) {
      const b = el('button', 'seo-tab' + (tab === t.id ? ' active' : ''));
      b.append(icon(t.icon, 14), el('span', null, t.label));
      b.onclick = () => { if (tab === t.id) return; tab = t.id; renderBody(); };
      row.appendChild(b);
    }
    return row;
  }

  // ---- Обзор ----
  function renderOverview(root, d) {
    const pass = el('div', 'seo-pass');
    pass.appendChild(passRow('Адрес', (d.fetch && d.fetch.finalUrl) || d.url));
    pass.appendChild(passRow('Статус', String(d.fetch.status) + (d.fetch.server ? ' · ' + d.fetch.server : '')));
    const tags = [];
    if (d.local) tags.push('локальный'); else tags.push('внешний');
    if (d.render) tags.push('рендер ✓'); else if (d.progress && d.progress.render) tags.push('рендер ⏳'); else if (d.renderError) tags.push('рендер ✗');
    if (d.render && d.render.dom && d.render.dom.tech && d.render.dom.tech.length) tags.push(d.render.dom.tech.slice(0, 3).join(', '));
    pass.appendChild(passRow('Сводка', tags.join(' · ')));
    root.appendChild(pass);

    const cards = el('div', 'seo-scores');
    cards.appendChild(scoreCard('Безопасность', d.scores.security));
    cards.appendChild(scoreCard('SEO', d.scores.seo));
    cards.appendChild(scoreCard('Скорость', d.scores.perf));
    root.appendChild(cards);

    // Тренд относительно прошлого снимка.
    const site = curSite();
    if (site && site.snaps && site.snaps.length > 1) {
      const cur = site.snaps[0], prev = site.snaps[1];
      const tr = el('div', 'seo-trend');
      tr.appendChild(el('span', 'seo-trend-lbl', 'С прошлого раза:'));
      tr.appendChild(trendItem('Безоп.', cur.scores.security, prev.scores.security));
      tr.appendChild(trendItem('SEO', cur.scores.seo, prev.scores.seo));
      tr.appendChild(trendItem('Скор.', cur.scores.perf, prev.scores.perf));
      root.appendChild(tr);
    }

    // Скриншоты.
    if (d.render && d.render.screenshot && (d.render.screenshot.desktop || d.render.screenshot.mobile)) {
      const shots = el('div', 'seo-shots');
      if (d.render.screenshot.desktop) { const im = el('img', 'seo-shot'); im.src = d.render.screenshot.desktop; im.title = 'Десктоп'; shots.appendChild(im); }
      if (d.render.screenshot.mobile) { const im = el('img', 'seo-shot seo-shot-m'); im.src = d.render.screenshot.mobile; im.title = 'Мобильный'; shots.appendChild(im); }
      root.appendChild(shots);
    }

    const acts = el('div', 'seo-actions');
    const sumBtn = el('button', 'seo-actbtn'); sumBtn.append(icon('copy', 14), el('span', null, 'Сводка'));
    sumBtn.onclick = () => { lite.copyText(buildSummaryMd(d)); toast('Сводка скопирована'); };
    const expBtn = el('button', 'seo-actbtn'); expBtn.append(icon('download', 14), el('span', null, 'Экспорт'));
    expBtn.onclick = () => exportReport(d);
    acts.append(sumBtn, expBtn);
    root.appendChild(acts);

    const f = d.findings || [];
    const chips = el('div', 'seo-chips');
    const crit = f.filter((x) => x.sev === 'crit').length, warn = f.filter((x) => x.sev === 'warn').length, info = f.filter((x) => x.sev === 'info').length;
    if (crit) chips.appendChild(sevChip('crit', crit, 'критично'));
    if (warn) chips.appendChild(sevChip('warn', warn, 'важно'));
    if (info) chips.appendChild(sevChip('info', info, 'инфо'));
    if (!f.length) chips.appendChild(el('div', 'seo-allgood', '✓ Замечаний не найдено'));
    root.appendChild(chips);

    const topf = f.slice().sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev]).slice(0, 14);
    if (topf.length) {
      root.appendChild(el('div', 'seo-h', 'Главные находки'));
      const list = el('div', 'seo-find');
      for (const x of topf) list.appendChild(findRow(x));
      root.appendChild(list);
    }
  }
  function passRow(k, v) { const r = el('div', 'seo-passrow'); r.appendChild(el('span', 'seo-passk', k)); r.appendChild(el('span', 'seo-passv', v || '—')); return r; }
  function scoreCard(label, val) {
    const cls = val == null ? 'na' : val >= 80 ? 'ok' : val >= 50 ? 'warn' : 'crit';
    const c = el('div', 'seo-scard seo-' + cls);
    c.appendChild(el('div', 'seo-sval', val == null ? '—' : String(val)));
    c.appendChild(el('div', 'seo-ssub', '/ 100'));
    c.appendChild(el('div', 'seo-slbl', label));
    return c;
  }
  function trendItem(lbl, cur, prev) {
    const d = (cur == null || prev == null) ? null : cur - prev;
    const span = el('span', 'seo-trend-i');
    const arrow = d == null ? '·' : d > 0 ? '▲' + d : d < 0 ? '▼' + Math.abs(d) : '=';
    span.appendChild(el('span', 'seo-trend-k', lbl));
    span.appendChild(el('span', 'seo-trend-v ' + (d > 0 ? 'seo-up' : d < 0 ? 'seo-down' : ''), arrow));
    return span;
  }
  function sevChip(sev, n, lbl) {
    const c = el('button', 'seo-chip seo-' + sev);
    c.append(el('span', 'seo-chip-n', String(n)), el('span', null, lbl));
    c.onclick = () => { tab = sev === 'crit' || sev === 'warn' ? 'security' : 'seo'; renderBody(); };
    return c;
  }
  // Строка находки.
  function findRow(x) {
    const r = el('div', 'seo-frow seo-' + x.sev);
    r.appendChild(el('span', 'seo-dot seo-' + x.sev));
    const w = el('div', 'seo-fwrap');
    w.appendChild(el('div', 'seo-ftitle', (x.cat ? '[' + x.cat + '] ' : '') + x.title));
    if (x.advice) w.appendChild(el('div', 'seo-fadvice', x.advice));
    r.appendChild(w);
    return r;
  }

  // ---- Безопасность ----
  function renderSecurity(root, d) {
    root.appendChild(el('div', 'seo-h', 'Заголовки безопасности'));
    const list = el('div', 'seo-rows');
    for (const s of (d.security || [])) {
      const row = el('div', 'seo-srow');
      row.appendChild(el('span', 'seo-dot seo-' + s.sev));
      const w = el('div', 'seo-fwrap');
      w.appendChild(el('div', 'seo-ftitle', s.label));
      w.appendChild(el('div', 'seo-fadvice', s.present ? (s.value.length > 100 ? s.value.slice(0, 100) + '…' : s.value) : s.advice));
      row.appendChild(w);
      row.appendChild(el('span', 'seo-tag seo-' + s.sev, s.present ? 'есть' : (s.sev === 'info' ? 'нет' : SEV_LABEL[s.sev])));
      list.appendChild(row);
    }
    root.appendChild(list);

    if (d.exposed && (d.exposed.git || d.exposed.env)) {
      root.appendChild(el('div', 'seo-h', '⚠ Утечки'));
      const box = el('div', 'seo-rows');
      if (d.exposed.git) box.appendChild(exposeRow('Открыт /.git/', 'Можно выкачать исходный код'));
      if (d.exposed.env) box.appendChild(exposeRow('Открыт /.env', 'Возможны ключи и пароли в публичном доступе'));
      root.appendChild(box);
    }

    if (d.tls) {
      root.appendChild(el('div', 'seo-h', 'TLS-сертификат'));
      if (!d.tls.ok) root.appendChild(el('div', 'seo-empty seo-err', d.tls.error || 'недоступен'));
      else {
        const t = d.tls, box = el('div', 'seo-kv');
        box.appendChild(kv('Издатель', t.issuer || '—'));
        box.appendChild(kv('Субъект', t.subject || '—'));
        box.appendChild(kv('Протокол / шифр', (t.protocol || '—') + (t.cipher ? ' · ' + t.cipher : '')));
        box.appendChild(kv('Доверие', t.authorized ? 'валиден' : ('не доверен: ' + (t.authError || '?'))));
        box.appendChild(kv('Действует до', (t.validTo || '—') + ' (' + t.daysLeft + ' дн)'));
        if (t.chain && t.chain.length) box.appendChild(kv('Цепочка', t.chain.join(' → ')));
        if (t.san && t.san.length) box.appendChild(kv('SAN', t.san.join(', ')));
        root.appendChild(box);
      }
    }

    if (d.cookies && d.cookies.length) {
      root.appendChild(el('div', 'seo-h', 'Куки (' + d.cookies.length + ')'));
      const list2 = el('div', 'seo-rows');
      for (const c of d.cookies) {
        const row = el('div', 'seo-srow');
        const w = el('div', 'seo-fwrap');
        w.appendChild(el('div', 'seo-ftitle', c.name || '(без имени)'));
        w.appendChild(el('div', 'seo-fadvice', [c.secure ? 'Secure' : '✗Secure', c.httpOnly ? 'HttpOnly' : '✗HttpOnly', 'SameSite=' + (c.sameSite || '—')].join(' · ')));
        row.appendChild(w);
        list2.appendChild(row);
      }
      root.appendChild(list2);
    }
  }
  function exposeRow(title, sub) {
    const row = el('div', 'seo-srow');
    row.appendChild(el('span', 'seo-dot seo-crit'));
    const w = el('div', 'seo-fwrap'); w.appendChild(el('div', 'seo-ftitle', title)); w.appendChild(el('div', 'seo-fadvice', sub));
    row.appendChild(w); row.appendChild(el('span', 'seo-tag seo-crit', 'утечка'));
    return row;
  }
  function kv(k, v) { const r = el('div', 'seo-kvrow'); r.appendChild(el('span', 'seo-kvk', k)); r.appendChild(el('span', 'seo-kvv', v)); return r; }

  // ---- SEO ----
  function renderSeoTab(root, d) {
    const rendered = d.render && d.render.dom && !d.render.dom.error ? d.render.dom : null;
    // Переключатель источника (если есть рендер).
    if (rendered) {
      const seg = el('div', 'seo-seg');
      for (const v of [['rendered', 'после JS'], ['raw', 'исходный HTML']]) {
        const b = el('button', 'seo-segbtn' + (seoView === v[0] ? ' active' : ''), v[1]);
        b.onclick = () => { if (seoView === v[0]) return; seoView = v[0]; renderBody(); };
        seg.appendChild(b);
      }
      root.appendChild(seg);
    }
    const s = (rendered && seoView === 'rendered') ? rendered : (d.seo || {});

    const box = el('div', 'seo-kv');
    box.appendChild(kv('Title', s.title ? s.title + '  (' + s.title.length + ')' : '— нет'));
    box.appendChild(kv('Description', s.description ? s.description + '  (' + s.description.length + ')' : '— нет'));
    box.appendChild(kv('Canonical', s.canonical || '— нет'));
    box.appendChild(kv('Viewport', s.viewport || '— нет'));
    box.appendChild(kv('Lang / robots', (s.lang || '—') + ' / ' + (s.robotsMeta || '—')));
    box.appendChild(kv('H1', String(s.h1Count != null ? s.h1Count : '—')));
    box.appendChild(kv('Картинки', (s.imgCount || 0) + ' (без alt: ' + (s.imgNoAlt || 0) + (s.imgNoDim != null ? ', без размеров: ' + s.imgNoDim : '') + ')'));
    box.appendChild(kv('OpenGraph', s.og && s.og.title ? 'есть (' + Object.keys(s.og).join(', ') + ')' : '— нет'));
    box.appendChild(kv('JSON-LD', s.hasJsonLd ? 'есть' : '— нет'));
    if (s.textLen != null) box.appendChild(kv('Объём текста', s.textLen + ' симв'));
    root.appendChild(box);

    // Дерево заголовков (только из рендера).
    if (rendered && seoView === 'rendered' && rendered.h) {
      const counts = Object.entries(rendered.h).map(([k, arr]) => k.toUpperCase() + ':' + arr.length).join('  ');
      root.appendChild(el('div', 'seo-h', 'Заголовки  ' + counts));
    }

    root.appendChild(el('div', 'seo-h', 'Служебные файлы'));
    const files = el('div', 'seo-rows');
    files.appendChild(fileRow('robots.txt', d.files && d.files.robots));
    files.appendChild(fileRow('sitemap.xml', d.files && d.files.sitemap));
    files.appendChild(fileRow('security.txt', d.files && d.files.securityTxt));
    root.appendChild(files);

    // Ссылки.
    if (rendered && rendered.links) {
      root.appendChild(el('div', 'seo-h', 'Ссылки: внутр. ' + rendered.links.internal.length + ' · внеш. ' + rendered.links.external.length));
      const bl = d.render.brokenLinks;
      if (bl && bl.broken.length) {
        root.appendChild(el('div', 'seo-foot', 'Проверено ' + bl.checked + ', битых ' + bl.broken.length + ':'));
        const list = el('div', 'seo-rows');
        for (const b of bl.broken.slice(0, 30)) {
          const row = el('div', 'seo-srow');
          row.appendChild(el('span', 'seo-dot seo-warn'));
          const w = el('div', 'seo-fwrap'); w.appendChild(el('div', 'seo-ftitle', b.url)); w.appendChild(el('div', 'seo-fadvice', 'код: ' + b.status));
          row.appendChild(w); list.appendChild(row);
        }
        root.appendChild(list);
      } else if (bl) root.appendChild(el('div', 'seo-foot', '✓ Битых ссылок не найдено (проверено ' + bl.checked + ')'));
      else if (d.progress && d.progress.links) root.appendChild(el('div', 'seo-foot', 'Проверяю ссылки…'));
    }

    const issues = (d.seo && d.seo.issues) || [];
    if (issues.length) {
      root.appendChild(el('div', 'seo-h', 'Замечания SEO'));
      const list = el('div', 'seo-find');
      for (const x of issues.slice().sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev])) list.appendChild(findRow({ ...x, cat: 'SEO' }));
      root.appendChild(list);
    }
  }
  function fileRow(name, info) {
    const found = info && info.found;
    const row = el('div', 'seo-srow');
    row.appendChild(el('span', 'seo-dot seo-' + (found ? 'ok' : 'info')));
    const w = el('div', 'seo-fwrap'); w.appendChild(el('div', 'seo-ftitle', '/' + name)); w.appendChild(el('div', 'seo-fadvice', found ? (fmtBytes(info.bytes) + ' — найден') : 'не найден'));
    row.appendChild(w); row.appendChild(el('span', 'seo-tag seo-' + (found ? 'ok' : 'info'), found ? 'есть' : 'нет'));
    return row;
  }

  // ---- Скорость ----
  function renderPerf(root, d) {
    if (!d.render) {
      const msg = (d.progress && d.progress.render) ? 'Идёт рендер страницы — метрики появятся через пару секунд…'
        : d.renderError ? ('Глубокий аудит не удался: ' + d.renderError) : 'Метрики доступны только после рендера страницы.';
      root.appendChild(el('div', 'seo-empty', msg)); return;
    }
    const p = d.render.perf || {};
    root.appendChild(el('div', 'seo-h', 'Core Web Vitals и тайминги'));
    const grid = el('div', 'seo-metrics');
    grid.appendChild(metric('LCP', fmtMs(p.lcp), p.lcp > 4000 ? 'crit' : p.lcp > 2500 ? 'warn' : 'ok'));
    grid.appendChild(metric('CLS', p.cls != null ? String(p.cls) : '—', p.cls > 0.25 ? 'crit' : p.cls > 0.1 ? 'warn' : 'ok'));
    grid.appendChild(metric('FCP', fmtMs(p.fcp), p.fcp > 3000 ? 'warn' : 'ok'));
    grid.appendChild(metric('TTFB', fmtMs(p.ttfb), p.ttfb > 800 ? 'warn' : 'ok'));
    grid.appendChild(metric('Load', fmtMs(p.load), p.load > 5000 ? 'crit' : p.load > 3000 ? 'warn' : 'ok'));
    grid.appendChild(metric('DOM-узлов', p.domNodes != null ? String(p.domNodes) : '—', p.domNodes > 1500 ? 'warn' : 'ok'));
    root.appendChild(grid);

    const net = d.render.network;
    if (net) {
      root.appendChild(el('div', 'seo-h', 'Вес страницы: ' + fmtBytes(net.bytes) + ' · ' + net.requests + ' запросов'));
      const meta = el('div', 'seo-kv');
      meta.appendChild(kv('Сторонние запросы', String(net.thirdParty)));
      meta.appendChild(kv('Без сжатия', fmtBytes(net.uncompressed)));
      root.appendChild(meta);
      // Разбивка по типам.
      const types = Object.entries(net.byType || {}).sort((a, b) => b[1] - a[1]);
      if (types.length) {
        const max = types[0][1] || 1;
        const bars = el('div', 'seo-bars');
        for (const [t, b] of types) {
          const r = el('div', 'seo-bar');
          r.appendChild(el('span', 'seo-bar-lbl', t));
          const track = el('div', 'seo-bar-track'); const fill = el('div', 'seo-bar-fill'); fill.style.width = Math.max(3, Math.round(b / max * 100)) + '%'; track.appendChild(fill);
          r.appendChild(track); r.appendChild(el('span', 'seo-bar-val', fmtBytes(b)));
          bars.appendChild(r);
        }
        root.appendChild(bars);
      }
      if (net.heavy && net.heavy.length) {
        root.appendChild(el('div', 'seo-h', 'Тяжёлые ресурсы'));
        const list = el('div', 'seo-rows');
        for (const h of net.heavy) {
          const row = el('div', 'seo-srow');
          const w = el('div', 'seo-fwrap'); w.appendChild(el('div', 'seo-ftitle', (h.url.split('/').pop() || h.url).slice(0, 60))); w.appendChild(el('div', 'seo-fadvice', h.type + ' · ' + h.url.slice(0, 80)));
          row.appendChild(w); row.appendChild(el('span', 'seo-fval', fmtBytes(h.bytes)));
          list.appendChild(row);
        }
        root.appendChild(list);
      }
    }
    // Консоль.
    const cons = (d.render.console || []);
    if (cons.length) {
      root.appendChild(el('div', 'seo-h', 'Консоль страницы (' + cons.length + ')'));
      const list = el('div', 'seo-rows');
      for (const c of cons.slice(0, 20)) {
        const row = el('div', 'seo-srow');
        row.appendChild(el('span', 'seo-dot seo-' + (c.level >= 3 ? 'crit' : 'warn')));
        row.appendChild(el('div', 'seo-fwrap', c.text));
        list.appendChild(row);
      }
      root.appendChild(list);
    }
  }
  function metric(lbl, val, cls) {
    const c = el('div', 'seo-metric seo-' + cls);
    c.appendChild(el('div', 'seo-metric-v', val));
    c.appendChild(el('div', 'seo-metric-l', lbl));
    return c;
  }

  // ---- Сеть/Домен ----
  function renderNetwork(root, d) {
    const reds = (d.fetch && d.fetch.redirects) || [];
    if (reds.length) {
      root.appendChild(el('div', 'seo-h', 'Цепочка редиректов'));
      const list = el('div', 'seo-rows');
      for (const r of reds) {
        const row = el('div', 'seo-srow');
        const w = el('div', 'seo-fwrap'); w.appendChild(el('div', 'seo-ftitle', r.status + ' → ' + r.to)); w.appendChild(el('div', 'seo-fadvice', 'из ' + r.from));
        row.appendChild(w); list.appendChild(row);
      }
      root.appendChild(list);
    }

    if (d.geo) {
      root.appendChild(el('div', 'seo-h', 'Сервер'));
      const box = el('div', 'seo-kv');
      box.appendChild(kv('IP', d.geo.query || '—'));
      box.appendChild(kv('Расположение', [d.geo.city, d.geo.country].filter(Boolean).join(', ') || '—'));
      box.appendChild(kv('Хостер', d.geo.isp || d.geo.org || '—'));
      box.appendChild(kv('ASN', d.geo.as || '—'));
      root.appendChild(box);
    }

    if (d.whois) {
      root.appendChild(el('div', 'seo-h', 'Домен (WHOIS)'));
      const box = el('div', 'seo-kv');
      box.appendChild(kv('Домен', d.whois.domain || '—'));
      box.appendChild(kv('Регистратор', d.whois.registrar || '—'));
      box.appendChild(kv('Создан', d.whois.created || '—'));
      box.appendChild(kv('Истекает', d.whois.expires || '—'));
      if (d.whois.ns && d.whois.ns.length) box.appendChild(kv('NS', d.whois.ns.join(', ')));
      root.appendChild(box);
    }

    if (d.dns && !d.dns.error) {
      root.appendChild(el('div', 'seo-h', 'DNS-записи'));
      const box = el('div', 'seo-kv');
      const rec = (k, arr) => { if (arr && arr.length) box.appendChild(kv(k, arr.join(', '))); };
      rec('A', d.dns.a); rec('AAAA', d.dns.aaaa); rec('MX', d.dns.mx); rec('NS', d.dns.ns); rec('CAA', d.dns.caa);
      if (d.dns.txt && d.dns.txt.length) box.appendChild(kv('TXT', d.dns.txt.join(' | ')));
      root.appendChild(box);
      if (d.dns.mail) {
        root.appendChild(el('div', 'seo-h', 'Почтовая гигиена'));
        const files = el('div', 'seo-rows');
        const mr = (name, info, extra) => {
          const row = el('div', 'seo-srow');
          row.appendChild(el('span', 'seo-dot seo-' + (info.found ? 'ok' : 'warn')));
          const w = el('div', 'seo-fwrap'); w.appendChild(el('div', 'seo-ftitle', name)); w.appendChild(el('div', 'seo-fadvice', info.found ? ((info.value || '') + (extra || '')).slice(0, 120) : 'запись отсутствует'));
          row.appendChild(w); row.appendChild(el('span', 'seo-tag seo-' + (info.found ? 'ok' : 'warn'), info.found ? 'есть' : 'нет'));
          return row;
        };
        files.appendChild(mr('SPF', d.dns.mail.spf));
        files.appendChild(mr('DMARC', d.dns.mail.dmarc, d.dns.mail.dmarc.policy ? ('  ' + d.dns.mail.dmarc.policy) : ''));
        root.appendChild(files);
      }
    } else if (d.local) {
      root.appendChild(el('div', 'seo-foot', 'DNS/WHOIS/гео неприменимы к локальному сайту.'));
    }

    root.appendChild(el('div', 'seo-h', 'Заголовки ответа'));
    const box2 = el('div', 'seo-kv seo-headers');
    const hh = d.headers || {};
    for (const k of Object.keys(hh).sort()) box2.appendChild(kv(k, Array.isArray(hh[k]) ? hh[k].join('; ') : String(hh[k])));
    root.appendChild(box2);
  }

  // ---- История ----
  function renderHistory(root) {
    const site = curSite();
    const snaps = (site && site.snaps) || [];
    if (!snaps.length) { root.appendChild(el('div', 'seo-empty', 'Истории пока нет — сделайте аудит.')); return; }
    root.appendChild(el('div', 'seo-h', 'Снимки аудита (новые сверху)'));
    const list = el('div', 'seo-rows');
    for (let i = 0; i < snaps.length; i++) {
      const s = snaps[i], prev = snaps[i + 1];
      const row = el('div', 'seo-srow');
      const w = el('div', 'seo-fwrap');
      w.appendChild(el('div', 'seo-ftitle', (s.at ? s.at.slice(0, 16).replace('T', ' ') : '—') + '  ·  HTTP ' + s.status));
      const sc = s.scores || {};
      const parts = ['Безоп. ' + (sc.security != null ? sc.security : '—'), 'SEO ' + (sc.seo != null ? sc.seo : '—'), 'Скор. ' + (sc.perf != null ? sc.perf : '—')];
      if (s.perf) parts.push('LCP ' + fmtMs(s.perf.lcp));
      if (s.bytes != null) parts.push(fmtBytes(s.bytes));
      w.appendChild(el('div', 'seo-fadvice', parts.join(' · ')));
      row.appendChild(w);
      // дельта оценок vs предыдущий
      if (prev) {
        const dv = (a, b) => (a == null || b == null) ? 0 : a - b;
        const total = dv(sc.security, prev.scores.security) + dv(sc.seo, prev.scores.seo) + dv(sc.perf, prev.scores.perf);
        row.appendChild(el('span', 'seo-tag ' + (total > 0 ? 'seo-ok' : total < 0 ? 'seo-crit' : ''), total > 0 ? '▲ лучше' : total < 0 ? '▼ хуже' : '= без изм.'));
      }
      list.appendChild(row);
    }
    root.appendChild(list);
    if (snaps.length > 1) root.appendChild(el('div', 'seo-foot', 'Дельта на «Обзоре» сравнивает последние два аудита. Скриншоты в историю не сохраняются.'));
  }

  // ---------------- экспорт / сводка ----------------
  function buildSummaryMd(d) {
    const L = [];
    L.push('# WEB/SEO аудит — ' + ((d.fetch && d.fetch.finalUrl) || d.url));
    L.push('');
    L.push('- Статус: ' + d.fetch.status + (d.fetch.server ? ' · ' + d.fetch.server : '') + ' · ' + (d.local ? 'локальный' : 'внешний'));
    if (d.scores) L.push('- Оценки: Безопасность ' + d.scores.security + ' · SEO ' + d.scores.seo + ' · Скорость ' + (d.scores.perf != null ? d.scores.perf : '—') + ' (из 100)');
    if (d.render && d.render.perf) { const p = d.render.perf; L.push('- CWV: LCP ' + fmtMs(p.lcp) + ' · CLS ' + p.cls + ' · Load ' + fmtMs(p.load)); }
    if (d.render && d.render.network) L.push('- Вес: ' + fmtBytes(d.render.network.bytes) + ' · ' + d.render.network.requests + ' запросов');
    if (d.render && d.render.dom && d.render.dom.tech && d.render.dom.tech.length) L.push('- Техстек: ' + d.render.dom.tech.join(', '));
    if (d.tls && d.tls.ok) L.push('- TLS: ' + (d.tls.issuer || '') + ', до ' + d.tls.validTo + ' (' + d.tls.daysLeft + ' дн)');
    L.push('');
    const f = (d.findings || []).slice().sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev]);
    if (f.length) { L.push('## Находки (' + f.length + ')'); for (const x of f) L.push('- [' + SEV_LABEL[x.sev] + '] ' + (x.cat ? x.cat + ': ' : '') + x.title + (x.advice ? ' — ' + x.advice : '')); }
    else L.push('## Находок не выявлено');
    return L.join('\n') + '\n';
  }
  function buildReportMd(d) {
    const L = [buildSummaryMd(d).trimEnd(), ''];
    const s = (d.render && d.render.dom && !d.render.dom.error) ? d.render.dom : (d.seo || {});
    L.push('## SEO (' + ((d.render && d.render.dom) ? 'после рендера' : 'сырой HTML') + ')');
    L.push('- Title: ' + (s.title || '—'));
    L.push('- Description: ' + (s.description || '—'));
    L.push('- Canonical: ' + (s.canonical || '—') + ' · Viewport: ' + (s.viewport || '—') + ' · Lang: ' + (s.lang || '—'));
    L.push('- H1: ' + (s.h1Count != null ? s.h1Count : '—') + ' · Картинок: ' + (s.imgCount || 0) + ' (без alt: ' + (s.imgNoAlt || 0) + ')');
    L.push('');
    L.push('## Заголовки безопасности');
    for (const x of (d.security || [])) L.push('- ' + x.label + ': ' + (x.present ? 'есть' : 'нет'));
    if (d.whois) { L.push(''); L.push('## Домен'); L.push('- Регистратор: ' + (d.whois.registrar || '—') + ' · создан: ' + (d.whois.created || '—') + ' · истекает: ' + (d.whois.expires || '—')); }
    return L.join('\n') + '\n';
  }
  async function exportReport(d) {
    const base = (hostOf(d.url).replace(/[^\p{L}\p{N}.-]+/gu, '_') || 'site') + '-seo-audit.md';
    const r = await lite.seo.export(buildReportMd(d), base);
    if (!r || r.canceled) return;
    if (r.error) { toast('Ошибка экспорта: ' + r.error, { kind: 'err' }); return; }
    toast('Отчёт сохранён');
  }

  // ---------------- панель правого слота ----------------
  function setSeoOpen(open, opts = {}) {
    if (open === seoOpen) { if (open) renderBody(); return; }
    if (open) closeOtherPanels('seo');
    const delta = layout.seo + GUTTER;
    seoOpen = open;
    $('#seo-pane').classList.toggle('hidden', !open);
    $('#gutter-seo').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta);
    saveUiState();
    if (open) renderBody();
    setTimeout(refitActiveTerminal, 150);
  }

  return {
    isOpen: () => seoOpen,
    setOpen: setSeoOpen,
    toggle: () => setSeoOpen(!seoOpen),
    renderPanel: () => { if (seoOpen) renderBody(); },
    rescan: () => { if (selectedUrl) scan(); },
  };
}
