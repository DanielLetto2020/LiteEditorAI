// LiteEditor — модуль «Монитор»: самонаблюдение редактора за потреблением ресурсов.
// Окно-модуль (открывается из меню «Модули»). Раз в ~3с зовёт monitor:sample в main и рисует
// ДВЕ раздельные сводки:
//   • «Редактор (Electron)» — процессы самого приложения (main + рендереры окон + GPU). Это и есть
//     то, что можно оптимизировать (число открытых окон-модулей, утечки в конкретном окне).
//   • «Агенты в терминалах» — деревья процессов PTY (claude/codex/шелл). Полезная нагрузка, к
//     редактору отношения почти не имеет; показываем отдельно, чтобы не пугать суммой.
// Изолирован по правилам: всё из ядра — через host/window.lite; UI — из ui.js; темизация — токены.
// host: ничего проектного не требует (самостоятельный модуль).
import { el, toast } from '../ui.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;
const POLL_MS = 3000;
const HIST_MAX = 120;          // история суммарной памяти редактора для спарклайна (≈6 мин)

function fmtMB(bytes) {
  const mb = (bytes || 0) / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' ГБ';
  return mb.toFixed(mb >= 100 ? 0 : 1) + ' МБ';
}
const fmtCpu = (p) => (p || 0).toFixed(1) + '%';
const STATE_RU = { running: 'работает', waiting: 'ждёт ввода', shell: 'простаивает' };

export function initMonitor() {
  let open = false;
  let timer = null;
  let last = null;             // последний снимок
  let peakEditor = 0;          // пик памяти редактора за сессию монитора
  const hist = [];             // суммарная память редактора по времени (спарклайн)

  async function sample() {
    let res;
    try { res = await lite.monitor.sample(); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    if (!res || res.ok === false) { if (res && res.error) toast('Монитор: ' + res.error, { kind: 'err' }); return; }
    last = res;
    peakEditor = Math.max(peakEditor, res.editor.totalMem);
    hist.push(res.editor.totalMem); if (hist.length > HIST_MAX) hist.shift();
    if (open) render();
  }

  // ---------------- рендер ----------------
  function row(left, cpu, mem) {
    const tr = el('div', 'mon-row');
    tr.appendChild(left);
    tr.appendChild(el('span', 'mon-cpu', cpu));
    tr.appendChild(mem);
    return tr;
  }
  function nameCell(main, sub) {
    const c = el('div', 'mon-name');
    c.appendChild(el('span', 'mon-name-main', main));
    c.appendChild(el('span', 'mon-name-sub', sub));
    return c;
  }
  function memCell(bytes, grand) {
    const c = el('div', 'mon-mem');
    c.appendChild(el('span', 'mon-mem-val', fmtMB(bytes)));
    const bar = el('div', 'mon-bar');
    const fill = el('div', 'mon-bar-fill');
    fill.style.width = Math.max(2, Math.min(100, Math.round((grand ? bytes / grand : 0) * 100))) + '%';
    bar.appendChild(fill); c.appendChild(bar);
    return c;
  }
  function card(label, valBytes, subText) {
    const c = el('div', 'mon-card');
    c.appendChild(el('div', 'mon-card-label', label));
    c.appendChild(el('div', 'mon-card-val', fmtMB(valBytes)));
    c.appendChild(el('div', 'mon-card-sub', subText));
    return c;
  }
  function secTitle(text, n) {
    const h = el('div', 'mon-sec');
    h.appendChild(el('span', 'mon-sec-t', text));
    h.appendChild(el('span', 'mon-sec-n', String(n)));
    return h;
  }
  function sparkline(arr) {
    const w = 260, h = 36, max = Math.max(...arr, 1);
    const step = w / Math.max(1, arr.length - 1);
    let d = '';
    arr.forEach((v, i) => { const x = i * step, y = h - (v / max) * (h - 4) - 2; d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' '; });
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.setAttribute('class', 'mon-spark');
    svg.setAttribute('preserveAspectRatio', 'none');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d.trim()); path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5');
    svg.appendChild(path);
    const wrap = el('div', 'mon-spark-wrap');
    wrap.appendChild(svg);
    wrap.appendChild(el('span', 'mon-spark-cap', 'память редактора, посл. ' + Math.round(arr.length * (POLL_MS / 1000)) + ' с'));
    return wrap;
  }

  function render() {
    const body = $('#monitor-body');
    if (!body) return;
    body.innerHTML = '';
    if (!last) { body.appendChild(el('div', 'mon-empty', 'Сбор данных…')); return; }
    const ed = last.editor, pt = last.pty;
    const grand = ed.totalMem + pt.totalMem;

    const sum = el('div', 'mon-summary');
    sum.appendChild(card('Редактор (Electron)', ed.totalMem, 'CPU ' + fmtCpu(ed.totalCpu) + ' · пик ' + fmtMB(peakEditor)));
    sum.appendChild(card('Агенты в терминалах', pt.totalMem, 'CPU ' + fmtCpu(pt.totalCpu) + ' · полезная нагрузка'));
    body.appendChild(sum);
    if (hist.length > 1) body.appendChild(sparkline(hist));

    body.appendChild(secTitle('Процессы редактора', ed.procs.length));
    const t1 = el('div', 'mon-table');
    for (const p of ed.procs) {
      t1.appendChild(row(
        nameCell(p.label, p.type + (p.name ? ' · ' + p.name : '') + ' · pid ' + p.pid),
        fmtCpu(p.cpu), memCell(p.memBytes, grand)));
    }
    body.appendChild(t1);

    body.appendChild(secTitle('Терминалы / агенты', pt.procs.length));
    if (pt.note) body.appendChild(el('div', 'mon-note', pt.note));
    const t2 = el('div', 'mon-table');
    for (const p of pt.procs) {
      const st = STATE_RU[p.state] || '—';
      t2.appendChild(row(
        nameCell(p.label, (p.comm || 'шелл') + ' · ' + p.procs + ' проц. · ' + st + ' · pid ' + p.pid),
        fmtCpu(p.cpu), memCell(p.memBytes, grand)));
    }
    if (!pt.procs.length) t2.appendChild(el('div', 'mon-empty', 'Открытых терминалов нет.'));
    body.appendChild(t2);
  }

  // ---------------- снимок в буфер ----------------
  function copySnapshot() {
    if (!last) { toast('Нет данных'); return; }
    const L = [];
    L.push('LiteEditorAI — снимок ресурсов ' + new Date(last.ts).toLocaleString());
    L.push('');
    L.push('РЕДАКТОР (Electron): ' + fmtMB(last.editor.totalMem) + ', CPU ' + fmtCpu(last.editor.totalCpu) + ' (пик ' + fmtMB(peakEditor) + ')');
    for (const p of last.editor.procs) L.push('  ' + p.label + ' [' + p.type + ' pid ' + p.pid + '] — ' + fmtMB(p.memBytes) + ', CPU ' + fmtCpu(p.cpu));
    L.push('');
    L.push('ТЕРМИНАЛЫ/АГЕНТЫ: ' + fmtMB(last.pty.totalMem) + ', CPU ' + fmtCpu(last.pty.totalCpu));
    for (const p of last.pty.procs) L.push('  ' + p.label + ' [' + (p.comm || 'шелл') + ' pid ' + p.pid + '] — ' + fmtMB(p.memBytes) + ', CPU ' + fmtCpu(p.cpu) + ', ' + (STATE_RU[p.state] || '—'));
    try { navigator.clipboard.writeText(L.join('\n')); toast('Снимок скопирован', { kind: 'ok' }); }
    catch (_) { toast('Не удалось скопировать', { kind: 'err' }); }
  }

  // ---------------- жизненный цикл ----------------
  function startPoll() { if (!timer) { sample(); timer = setInterval(sample, POLL_MS); } }
  function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

  function setOpen(open_) {
    open = open_;
    const pane = $('#monitor-pane'); if (pane) pane.classList.toggle('hidden', !open);
    const g = $('#gutter-monitor'); if (g) g.classList.toggle('hidden', !open);
    if (open) { render(); startPoll(); } else { stopPoll(); }
  }

  // Окно свёрнуто/скрыто → не семплить впустую; вернулось — возобновить.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPoll();
    else if (open) startPoll();
  });

  return {
    isOpen: () => open,
    setOpen,
    toggle: () => setOpen(!open),
    copySnapshot,
    refresh: sample,
  };
}
