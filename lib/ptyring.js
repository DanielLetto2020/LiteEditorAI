// Кольцевой буфер сырого вывода PTY в памяти main-процесса.
//
// Назначение: когда окно редактора перезагружается (обновление настроек, перезагрузка рендерера)
// и забирает свои живые терминалы через pty:adoptable → pty:create, xterm рождается пустым.
// Буфер хранит последние maxChars символов вывода каждой живой сессии (по умолчанию 128 КБ),
// чтобы новая страница мгновенно восстановила видимый экран и историю без записи на диск.
//
// При усечении старого хвоста разрез сдвигается за границу суррогатной пары UTF-16 и за конец
// оборванной управляющей последовательности CSI/OSC, чтобы в первой строке не всплывал мусор.
'use strict';

const DEFAULT_MAX_CHARS = 128 * 1024;

/**
 * Сдвигает позицию разреза строки `s` с индекса `cut` вправо, чтобы не разрезать:
 *  1) суррогатную пару UTF-16 (trailing surrogate 0xDC00..0xDFFF);
 *  2) незавершённую ESC-последовательность CSI (`\x1b[...`) или OSC (`\x1b]...`), начавшуюся до `cut`.
 * @param {string} s
 * @param {number} cut
 * @returns {number}
 */
function alignCut(s, cut) {
  let pos = Math.max(0, Math.min(cut, s.length));
  if (pos === 0 || pos >= s.length) return pos;

  const code = s.charCodeAt(pos);
  if (code >= 0xdc00 && code <= 0xdfff) pos++;

  // Проверяем небольшое окно слева от разреза на наличие открытого ESC.
  const lookback = Math.max(0, pos - 128);
  const esc = s.lastIndexOf('\x1b', pos - 1);
  if (esc >= lookback) {
    const next = s[esc + 1];
    if (next === '[') {
      // CSI: ESC [ <параметры 0x20..0x3F>* <финальный байт 0x40..0x7E>
      let i = esc + 2;
      const lim = Math.min(s.length, esc + 128);
      while (i < lim && s.charCodeAt(i) >= 0x20 && s.charCodeAt(i) <= 0x3f) i++;
      if (i < lim && s.charCodeAt(i) >= 0x40 && s.charCodeAt(i) <= 0x7e && i >= pos) {
        pos = i + 1;
      }
    } else if (next === ']') {
      // OSC: ESC ] ... (BEL \x07 или ST \x1b\\)
      let i = esc + 2;
      const lim = Math.min(s.length, esc + 512);
      while (i < lim) {
        const ch = s.charCodeAt(i);
        if (ch === 0x07) { if (i >= pos) pos = i + 1; break; }
        if (ch === 0x1b && s[i + 1] === '\\') { if (i + 1 >= pos) pos = i + 2; break; }
        i++;
      }
    } else if (esc + 1 === pos) {
      // Двухбайтовая ESC-последовательность, разрезанная сразу после \x1b
      pos = Math.min(s.length, esc + 2);
    }
  }
  return pos;
}

/**
 * Создаёт кольцевой буфер для одной PTY-сессии.
 * @param {number} [maxChars]
 */
function createPtyRing(maxChars = DEFAULT_MAX_CHARS) {
  const limit = Math.max(256, Number(maxChars) || DEFAULT_MAX_CHARS);
  /** @type {string[]} */
  let chunks = [];
  let head = 0;
  let total = 0;

  function compactIfNeeded() {
    if (head > 64 && head * 2 >= chunks.length) {
      chunks = chunks.slice(head);
      head = 0;
    }
  }

  /** @param {string} data */
  function push(data) {
    if (!data || typeof data !== 'string') return;
    if (data.length >= limit) {
      const cut = alignCut(data, data.length - limit);
      const tail = data.slice(cut);
      chunks = tail ? [tail] : [];
      head = 0;
      total = tail.length;
      return;
    }
    chunks.push(data);
    total += data.length;
    while (total > limit && head < chunks.length) {
      const over = total - limit;
      const first = chunks[head];
      if (first.length <= over) {
        total -= first.length;
        chunks[head] = '';
        head++;
      } else {
        const cut = alignCut(first, over);
        if (cut >= first.length) {
          total -= first.length;
          chunks[head] = '';
          head++;
        } else {
          chunks[head] = first.slice(cut);
          total -= cut;
        }
        break;
      }
    }
    compactIfNeeded();
  }

  function read() {
    if (head >= chunks.length || total === 0) return '';
    if (chunks.length - head === 1) return chunks[head];
    const joined = chunks.slice(head).join('');
    chunks = [joined];
    head = 0;
    total = joined.length;
    return joined;
  }

  function readTail(maxChars = 4096) {
    const cap = Math.max(64, Number(maxChars) || 4096);
    if (head >= chunks.length || total === 0) return '';
    if (total <= cap) return read();
    let acc = '';
    for (let i = chunks.length - 1; i >= head; i--) {
      acc = chunks[i] + acc;
      if (acc.length >= cap) {
        const cut = alignCut(acc, acc.length - cap);
        return acc.slice(cut);
      }
    }
    return acc;
  }

  function clear() {
    chunks = [];
    head = 0;
    total = 0;
  }

  return {
    push,
    read,
    readTail,
    clear,
    size: () => total,
  };
}

/**
 * Хранилище кольцевых буферов по идентификаторам сессий.
 * @param {number} [maxChars]
 */
function createRingStore(maxChars = DEFAULT_MAX_CHARS) {
  /** @type {Map<string, ReturnType<typeof createPtyRing>>} */
  const map = new Map();

  return {
    /** @param {string} id @param {string} data */
    push(id, data) {
      if (!id || !data) return;
      let ring = map.get(id);
      if (!ring) { ring = createPtyRing(maxChars); map.set(id, ring); }
      ring.push(data);
    },
    /** @param {string} id */
    read(id) {
      const ring = map.get(id);
      return ring ? ring.read() : '';
    },
    /** @param {string} id @param {number} [maxChars] */
    readTail(id, maxChars) {
      const ring = map.get(id);
      return ring ? ring.readTail(maxChars) : '';
    },
    /** @param {string} id */
    size(id) {
      const ring = map.get(id);
      return ring ? ring.size() : 0;
    },
    /** @param {string} id */
    delete(id) {
      const ring = map.get(id);
      if (ring) { ring.clear(); map.delete(id); }
    },
    clear() {
      for (const ring of map.values()) ring.clear();
      map.clear();
    },
  };
}

module.exports = { createPtyRing, createRingStore, alignCut, DEFAULT_MAX_CHARS };
