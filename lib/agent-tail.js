// Чистая очистка хвоста PTY-вывода для карточек «Центра агентов».
'use strict';

// Управляющие последовательности ANSI (CSI, OSC, DCS/PM/APC и 2-байтовые ESC).
const ANSI_ALL_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b(?:P|\^|_)[\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g;
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Извлечь последние N содержательных строк из сырого хвоста PTY,
 * учитывая ANSI-коды и прогресс-бары с возвратом каретки (\r).
 * @param {string} raw
 * @param {number} [maxLines]
 * @param {number} [maxLineLen]
 * @returns {string[]}
 */
function extractTailLines(raw, maxLines = 4, maxLineLen = 160) {
  if (!raw || typeof raw !== 'string') return [];
  const clean = raw.replace(ANSI_ALL_RE, '').replace(CTRL_RE, '');
  const rawLines = clean.split('\n');
  /** @type {string[]} */
  const out = [];

  for (const rawLine of rawLines) {
    // Если были \r без \n (спиннеры, прогресс-бары) — берём последний непустой сегмент
    let line = rawLine;
    if (line.includes('\r')) {
      const segs = line.split('\r');
      let picked = '';
      for (let i = segs.length - 1; i >= 0; i--) {
        if (segs[i].trim()) { picked = segs[i]; break; }
      }
      line = picked;
    }
    const trimmed = line.replace(/\s+$/g, '');
    if (!trimmed.trim()) continue;
    out.push(trimmed.length > maxLineLen ? trimmed.slice(0, maxLineLen - 1) + '…' : trimmed);
  }

  return out.slice(-Math.max(1, maxLines));
}

module.exports = { extractTailLines };
