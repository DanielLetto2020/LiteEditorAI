// Калькулятор: кнопочная сетка, живой предпросмотр результата, история (ctx.storage).
// Выражения считает собственный мини-парсер (рекурсивный спуск) — eval()/new Function()
// в редакторе ЗАБЛОКИРОВАНЫ CSP ('unsafe-eval' нет), вычисления пишутся кодом.
let unsubs = []; // все отписки — для deactivate

// + - * / % ( ), унарный минус, десятичные с точкой или запятой
function calcEval(src) {
  const s = String(src).replace(/,/g, '.').replace(/[\s_]+/g, '');
  if (!s) throw new Error('пусто');
  let i = 0;
  const num = () => {
    const m = /^\d*\.?\d+/.exec(s.slice(i));
    if (!m) throw new Error('ожидалось число');
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const factor = () => {
    if (s[i] === '-') { i++; return -factor(); }
    if (s[i] === '+') { i++; return factor(); }
    if (s[i] === '(') {
      i++;
      const v = expr();
      if (s[i] !== ')') throw new Error('нет закрывающей скобки');
      i++;
      return v;
    }
    return num();
  };
  const term = () => {
    let v = factor();
    while (s[i] === '*' || s[i] === '/' || s[i] === '%') {
      const op = s[i++], r = factor();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const expr = () => {
    let v = term();
    while (s[i] === '+' || s[i] === '-') {
      const op = s[i++], r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = expr();
  if (i < s.length) throw new Error('лишний символ «' + s[i] + '»');
  if (!Number.isFinite(v)) throw new Error('деление на ноль');
  return v;
}
const fmt = (v) => String(parseFloat(v.toFixed(10))); // срезаем хвосты двоичной арифметики

export function activate(ctx) {
  const { el, iconBtn } = ctx.ui;
  const root = el('div', 'ext-calculator');
  root.innerHTML = `
    <style>
      .ext-calculator { display:flex; flex-direction:column; gap:10px; padding:14px;
        color:var(--text); height:100%; box-sizing:border-box; }
      .ext-calculator .calc-in { background:var(--bg-input); color:var(--text);
        border:1px solid var(--border); border-radius:var(--radius); padding:10px 14px;
        font:inherit; font-size:16px; outline:none; text-align:right; }
      .ext-calculator .calc-in:focus { border-color:var(--border-accent); }
      .ext-calculator .calc-res { min-height:34px; font-size:24px; text-align:right;
        padding:0 6px; color:var(--text-dim); transition:color .15s; }
      .ext-calculator .calc-res.ok { color:var(--green-bright); }
      .ext-calculator .calc-res.err { color:var(--danger); font-size:13px; }
      .ext-calculator .calc-pad { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
      .ext-calculator .calc-btn { border:1px solid var(--border); border-radius:var(--radius);
        background:var(--surface); color:var(--text); font:inherit; font-size:16px;
        padding:10px 0; cursor:pointer; }
      .ext-calculator .calc-btn:hover { background:var(--hover-2); }
      .ext-calculator .calc-btn:active { background:var(--card-active-bg); box-shadow:var(--card-active-shadow); }
      .ext-calculator .calc-btn.op { color:var(--green-bright); background:var(--accent-soft); border-color:var(--border-accent); }
      .ext-calculator .calc-btn.danger { color:var(--danger); }
      .ext-calculator .calc-btn.eq { grid-column:1 / -1; background:var(--green); color:var(--accent-contrast); font-weight:700; border-color:var(--border-accent); }
      .ext-calculator .calc-hist-head { display:flex; align-items:center; margin-top:4px; }
      .ext-calculator .calc-hist-title { flex:1; font-size:11px; letter-spacing:.08em;
        text-transform:uppercase; color:var(--text-mute); }
      .ext-calculator .calc-hist { flex:1; min-height:0; overflow:auto; display:flex;
        flex-direction:column; gap:6px; }
      .ext-calculator .calc-row { display:flex; gap:8px; background:var(--surface);
        border:1px solid var(--border); border-radius:var(--radius); padding:6px 12px;
        cursor:pointer; font-size:13px; }
      .ext-calculator .calc-row:hover { background:var(--hover); }
      .ext-calculator .calc-row .ce { flex:1; color:var(--text-dim); overflow:hidden;
        text-overflow:ellipsis; white-space:nowrap; }
      .ext-calculator .calc-row .cv { color:var(--green-bright); font-weight:600; }
      .ext-calculator .calc-empty { color:var(--text-mute); font-size:12px; padding:4px 6px; }
    </style>
    <input class="calc-in" type="text" placeholder="0" spellcheck="false" autocomplete="off">
    <div class="calc-res"></div>
    <div class="calc-pad"></div>
    <div class="calc-hist-head"><span class="calc-hist-title">История</span></div>
    <div class="calc-hist"></div>`;
  ctx.panel.element.appendChild(root);

  const input = root.querySelector('.calc-in');
  const res = root.querySelector('.calc-res');
  const pad = root.querySelector('.calc-pad');
  const histBox = root.querySelector('.calc-hist');
  let history = ctx.storage.get('history', []); // [{expr, value}] — новые в начале

  const saveHist = () => ctx.storage.set('history', history.slice(0, 30));
  const renderHist = () => {
    histBox.innerHTML = '';
    if (!history.length) { histBox.appendChild(el('div', 'calc-empty', 'Пока пусто — посчитайте что-нибудь.')); return; }
    for (const h of history) {
      const row = el('div', 'calc-row');
      row.appendChild(el('span', 'ce', h.expr + ' ='));
      row.appendChild(el('span', 'cv', h.value));
      row.onclick = () => { input.value = h.expr; preview(); input.focus(); };
      histBox.appendChild(row);
    }
  };
  const clearBtn = iconBtn('icon-btn', 'trash', 'Очистить историю');
  clearBtn.addEventListener('click', () => { history = []; saveHist(); renderHist(); });
  root.querySelector('.calc-hist-head').appendChild(clearBtn);

  const preview = () => { // живой предпросмотр, ошибки молча гасим до «=»
    const v = input.value.trim();
    res.className = 'calc-res';
    if (!v) { res.textContent = ''; return; }
    try { res.textContent = '= ' + fmt(calcEval(v)); } catch (_) { res.textContent = '…'; }
  };
  const commit = () => {
    const v = input.value.trim();
    if (!v) return;
    try {
      const value = fmt(calcEval(v));
      res.className = 'calc-res ok';
      res.textContent = '= ' + value;
      history = [{ expr: v, value }, ...history.filter((h) => h.expr !== v)].slice(0, 30);
      saveHist(); renderHist();
    } catch (e) {
      res.className = 'calc-res err';
      res.textContent = '⚠ ' + e.message;
    }
  };

  // кнопочная сетка: подпись → действие/символ (÷ × − показываем красиво, считаем как / * -)
  const KEYS = ['C', '(', ')', '⌫', '7', '8', '9', '÷', '4', '5', '6', '×', '1', '2', '3', '−', '0', '.', '%', '+', '='];
  const CHAR = { '÷': '/', '×': '*', '−': '-' };
  for (const k of KEYS) {
    const b = el('button', 'calc-btn', k);
    if (k === '=') b.classList.add('eq');
    else if (k === 'C' || k === '⌫') b.classList.add('danger');
    else if ('÷×−+%()'.includes(k)) b.classList.add('op');
    b.addEventListener('click', () => {
      if (k === 'C') { input.value = ''; preview(); }
      else if (k === '⌫') { input.value = input.value.slice(0, -1); preview(); }
      else if (k === '=') commit();
      else { input.value += (CHAR[k] || k); preview(); }
      if (k !== '=') input.focus();
    });
    pad.appendChild(b);
  }
  input.addEventListener('input', preview);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
  renderHist();

  unsubs.push(ctx.commands.register('Калькулятор: открыть', () => ctx.panel.open()));
  setTimeout(() => input.focus(), 50);
}

export function deactivate() {
  for (const u of unsubs) { try { u(); } catch {} }
  unsubs = [];
}
