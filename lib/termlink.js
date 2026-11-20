// Разбор ссылок, по которым кликнули в терминале (гиперссылки OSC 8: ESC ] 8 ; ; URI ST текст ESC ] 8 ; ; ST).
// Их выводят Claude Code, `ls --hyperlink`, gcc, systemd и др. Без своего linkHandler xterm открывал
// их через confirm() + window.open(), а Electron такое окно запрещает — клик не делал ничего.
// Используется в renderer/termutil.js (termLinkHandler), покрыт test/termlink.test.js.

'use strict';

// Номер строки в хвосте пути или во фрагменте: «#L12», «#12», «:12», «:12:5» (колонку отбрасываем).
const FRAG_LINE_RE = /^#?L?(\d+)(?:[:C,]\d+)?$/i;
const TAIL_LINE_RE = /:(\d+)(?::\d+)?$/;

/**
 * Что делать со ссылкой из терминала.
 * @param {unknown} uri  строка из OSC 8 (не-строку — игнорируем)
 * @returns {{ kind: 'web', url: string } | { kind: 'file', path: string, line: number } | null}
 *   web — открыть во внешнем браузере; file — открыть локальный файл (line = 0, если строки нет);
 *   null — неизвестная схема (mailto:, javascript:, ssh: …) или мусор: молча игнорировать.
 */
function classifyTermLink(uri) {
  if (typeof uri !== 'string') return null;
  const s = uri.trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (u.protocol === 'http:' || u.protocol === 'https:') return { kind: 'web', url: u.href };
  if (u.protocol !== 'file:') return null;
  // Хост не проверяем: `ls --hyperlink` пишет file://<имя-машины>/путь — это всё равно эта машина.
  let p;
  try { p = decodeURIComponent(u.pathname); } catch (_) { return null; }
  if (!p || p === '/') return null;
  // Windows: file:///C:/dir → «/C:/dir» → «C:/dir».
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
  let line = 0;
  const fm = u.hash ? FRAG_LINE_RE.exec(u.hash.slice(1)) : null;
  if (fm) line = parseInt(fm[1], 10);
  else {
    const tm = TAIL_LINE_RE.exec(p);
    if (tm) { line = parseInt(tm[1], 10); p = p.slice(0, tm.index); }
  }
  return { kind: 'file', path: p, line };
}

module.exports = { classifyTermLink };
