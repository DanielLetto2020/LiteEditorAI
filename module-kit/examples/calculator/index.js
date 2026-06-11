// Калькулятор: поле выражения, результат, история (персист через ctx.storage).
let unsubs = []; // все отписки — для deactivate

export function activate(ctx) {
  const { el, toast } = ctx.ui;
  const root = el('div', 'ext-calculator');
  root.innerHTML = `
    <style>
      .ext-calculator { display:flex; flex-direction:column; gap:10px; padding:12px;
        color:var(--text); height:100%; box-sizing:border-box; }
      .ext-calculator input { background:var(--bg-input); color:var(--text);
        border:1px solid var(--border); border-radius:var(--radius); padding:10px 12px;
        font:inherit; outline:none; }
      .ext-calculator input:focus { border-color:var(--border-accent); }
      .ext-calculator .calc-res { font-size:22px; min-height:30px; }
      .ext-calculator .calc-hist { flex:1; overflow:auto; display:flex;
        flex-direction:column; gap:6px; }
      .ext-calculator .calc-row { background:var(--surface); border:1px solid var(--border);
        border-radius:var(--radius); padding:6px 10px; cursor:pointer;
        color:var(--text-dim); }
      .ext-calculator .calc-row:hover { background:var(--hover); }
    </style>
    <input type="text" placeholder="Выражение, например (2+3)*4" spellcheck="false">
    <div class="calc-res"></div>
    <div class="calc-hist"></div>`;
  ctx.panel.element.appendChild(root);

  const input = root.querySelector('input');
  const res = root.querySelector('.calc-res');
  const histBox = root.querySelector('.calc-hist');
  let history = ctx.storage.get('history', []); // [{expr, value}]

  const renderHist = () => {
    histBox.innerHTML = '';
    for (const h of history) {
      const row = ctx.ui.el('div', 'calc-row', `${h.expr} = ${h.value}`);
      row.onclick = () => { input.value = h.expr; compute(); };
      histBox.prepend(row);
    }
  };
  const compute = () => {
    const expr = input.value.trim();
    if (!expr) { res.textContent = ''; return; }
    if (!/^[\d\s+\-*/().,%]+$/.test(expr)) { res.textContent = '⚠ только арифметика'; return; }
    try {
      const value = Function(`"use strict"; return (${expr.replace(/,/g, '.')})`)();
      if (!Number.isFinite(value)) throw new Error();
      res.textContent = `= ${value}`;
      return value;
    } catch { res.textContent = '⚠ ошибка в выражении'; }
  };
  input.addEventListener('input', compute);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const value = compute();
    if (value === undefined) return;
    history = [...history.filter((h) => h.expr !== input.value.trim()),
               { expr: input.value.trim(), value }].slice(-30);
    ctx.storage.set('history', history);
    renderHist();
  });
  renderHist();

  // Команда в палитре Ctrl+K — открыть калькулятор откуда угодно.
  unsubs.push(ctx.commands.register('Калькулятор: открыть', () => ctx.panel.open()));
  setTimeout(() => input.focus(), 50);
}

export function deactivate() {
  for (const u of unsubs) { try { u(); } catch {} }
  unsubs = [];
}
