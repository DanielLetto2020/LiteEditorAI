// Склейка вывода PTY перед отправкой в окно. Используется в main.js (spawnPtyFor); тесты —
// test/ptybatch.test.js.
//
// node-pty отдаёт вывод мелкими кусками, и раньше каждый уходил в окно отдельным IPC-сообщением.
// Замер 22.09.2026: `yes | head -c 20M` — 67 768 сообщений по ~443 Б, около 4 с процессора
// в главном процессе и столько же в окне. Пока идёт такой поток, главный процесс занят и тормозит
// всё остальное: IPC окон модулей, перемещение окна, другие терминалы.
// После склейки, тот же сценарий: ~500 сообщений вместо ~70 000, окно тратит на поток на ~15%
// меньше процессора; главный поток main — столько же (его время съедает само чтение PTY: node-pty
// отдаёт такой поток кусками по ~60 байт). Пробовали короткие паузы чтения под лавиной — главный
// поток −18%, но поток шёл на четверть дольше и выигрыш окна пропадал; оставлена только склейка.
//
// Правило склейки:
//   • кусок после тишины (с прошлой отправки прошло ≥ windowMs, в буфере пусто) уходит СРАЗУ —
//     эхо набора и ответ на Enter не ждут, задержка ввода та же, что была;
//   • пока вывод идёт потоком, куски копятся и уходят пачкой раз в windowMs или как только
//     набралось maxBytes — сообщений на два порядка меньше;
//   • flush() досылает остаток; его зовут перед pty:exit, чтобы хвост вывода не пришёл после выхода.

/**
 * @param {(data: string) => void} send
 * @param {{ windowMs?: number, maxBytes?: number, now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void }} [opts]
 */
function createBatcher(send, opts = {}) {
  const windowMs = opts.windowMs == null ? 5 : opts.windowMs;
  const maxBytes = opts.maxBytes || 64 * 1024;
  const now = opts.now || Date.now;
  const setTimer = opts.setTimer || setTimeout;
  const clearTimer = opts.clearTimer || clearTimeout;
  let parts = [];
  let size = 0;
  let timer = null;
  let lastSent = -Infinity;

  function flush() {
    if (timer) { clearTimer(timer); timer = null; }
    if (!parts.length) return;
    const data = parts.length === 1 ? parts[0] : parts.join('');
    parts = []; size = 0;
    lastSent = now();
    send(data);
  }

  function push(data) {
    if (!data) return;
    if (!parts.length && !timer && now() - lastSent >= windowMs) {
      lastSent = now();
      send(data);
      return;
    }
    parts.push(data);
    size += data.length;
    if (size >= maxBytes) { flush(); return; }
    if (!timer) timer = setTimer(() => { timer = null; flush(); }, windowMs);
  }

  return { push, flush };
}

module.exports = { createBatcher };
