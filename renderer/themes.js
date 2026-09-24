// Тема редактора — одна: «Графит». Выбора тем больше нет: палитру пользователь настраивает сам
// (панель «Оформление» в редакторе), настройка живёт в settings.look и общая для редактора и окон
// модулей (settings синхронизируются между окнами — renderer/settings-sync.js).
//
// Устройство: задаётся несколько БАЗОВЫХ цветов (фон, панели, границы, выделенная строка, текст,
// приглушённый текст) + акцент и цвета состояний. Остальные токены контракта выводятся из них
// смешиванием — поэтому смена фона не разваливает интерфейс. Любой выведенный токен можно
// переопределить вручную (look.over). Применение — CSS-переменные на :root; контракт токенов и
// значения по умолчанию (без вспышки до первого applyLook) — в начале styles.css.

export const LOOK_DEFAULT = Object.freeze({
  accent: '#3ecf8e',
  r: 16,      // скругление карточек; мелкие элементы — пропорционально (--r2/--r3)
  row: 34,    // высота строки проекта в боковой панели
  alpha: 90,  // непрозрачность фона окон (редактор, терминал, окна модулей), %; карточки и меню всегда плотные
  base: { ground: '#0e0e10', card: '#18181b', border: '#26262a', raised: '#252529', text: '#ececee', muted: '#8b8b93' },
  status: { warn: '#e8a33d', ok: '#4cc38a', danger: '#e5746b' },
  over: {},
});

// Подписи для панели «Оформление» (ключ перевода = сама строка, см. i18n).
export const LOOK_BASE_NAMES = {
  ground: 'Фон окна и терминала', card: 'Панели и карточки', border: 'Границы панелей',
  raised: 'Выделенная строка', text: 'Основной текст', muted: 'Приглушённый текст',
};
export const LOOK_STATUS_NAMES = { warn: 'Ждёт ответа', ok: 'Готов', danger: 'Ошибки и удаление' };
// Выведенные токены, которые можно переопределить руками (раздел «Все цвета»).
export const LOOK_TOKEN_NAMES = {
  'row-hover': 'Наведение', 'border-strong': 'Граница выделения', 'bg-input': 'Поля ввода', 'input-b': 'Граница полей',
  'text-hi': 'Яркий текст', text2: 'Текст списков', text3: 'Подписи', icon: 'Иконки', 'text-mute': 'Едва заметный текст',
  'bg-pop': 'Меню и поповеры', toast: 'Уведомления', tip: 'Подсказки', 'tip-b': 'Граница подсказок', press: 'Нажатие',
  tline: 'Линии в терминале', tline2: 'Пунктир в терминале',
};

const HEX = /^#[0-9a-f]{6}$/i;
// Только строка: RegExp.test приводит аргумент к строке, и ['#aabbcc'] из битого settings.json/импорта
// проходил проверку, а следом .toLowerCase() бросал — окно редактора и окна модулей не стартовали.
const isHex = (v) => typeof v === 'string' && HEX.test(v);
const hex2rgb = (x) => { const n = parseInt(x.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgb2hex = (a) => '#' + a.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
export const mixHex = (a, b, t) => { const A = hex2rgb(a), B = hex2rgb(b); return rgb2hex(A.map((v, i) => v + (B[i] - v) * t)); };
const alpha = (x, a) => x + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const pick = (src, def) => { const out = {}; for (const k of Object.keys(def)) out[k] = (src && isHex(src[k])) ? src[k].toLowerCase() : def[k]; return out; };

// Нормализованная настройка из settings (окна модулей держат settings без дефолтов редактора).
export function lookOf(settings) {
  const l = (settings && settings.look) || {};
  const over = {};
  if (l.over && typeof l.over === 'object') for (const [k, v] of Object.entries(l.over)) if (LOOK_TOKEN_NAMES[k] && isHex(v)) over[k] = v.toLowerCase();
  return {
    accent: isHex(l.accent) ? l.accent.toLowerCase() : LOOK_DEFAULT.accent,
    r: num(l.r, 4, 22, LOOK_DEFAULT.r),
    row: num(l.row, 28, 42, LOOK_DEFAULT.row),
    alpha: num(l.alpha, 60, 100, LOOK_DEFAULT.alpha),
    base: pick(l.base, LOOK_DEFAULT.base),
    status: pick(l.status, LOOK_DEFAULT.status),
    over,
  };
}

// Полный набор токенов (имена без «--»): контракт styles.css + токены новой оболочки.
export function lookTokens(look) {
  const b = look.base, s = look.status, acc = look.accent;
  const t = {
    // поверхности
    // app-bg — полупрозрачный фон окна (редактор, шапка окна модуля); mod-bg — тело окна модуля: цвет
    // панелей с той же непрозрачностью (модули свёрстаны на фоне-панели, так внутри ничего не съезжает)
    bg: b.ground, bar: b.ground, 'app-bg': alpha(b.ground, look.alpha / 100), 'mod-bg': alpha(b.card, look.alpha / 100),
    panel: b.card, 'panel-solid': b.card, modal: b.card, surface: b.card,
    'surface-2': alpha(b.text, 0.04), 'bg-input': mixHex(b.ground, b.card, 0.4), 'input-b': mixHex(b.border, b.text, 0.02),
    'bg-pop': mixHex(b.card, b.raised, 0.3), ink: b.ground, 'ink-2': mixHex(b.ground, b.card, 0.5),
    raised: b.raised, 'row-hover': mixHex(b.card, b.raised, 0.45), press: mixHex(b.raised, b.text, 0.045),
    toast: mixHex(b.card, b.raised, 0.6), tip: mixHex(b.raised, b.text, 0.02), 'tip-b': mixHex(b.raised, b.text, 0.085),
    // линии
    border: b.border, 'border-strong': mixHex(b.raised, b.text, 0.05), 'app-border': b.border,
    tline: mixHex(b.raised, b.muted, 0.3), tline2: mixHex(b.raised, b.muted, 0.2),
    // текст
    text: b.text, 'text-dim': b.muted, 'text-mute': mixHex(b.muted, b.card, 0.35),
    text2: mixHex(b.text, b.muted, 0.25), text3: mixHex(b.text, b.muted, 0.45), icon: mixHex(b.text, b.muted, 0.72),
    'text-hi': mixHex(b.text, '#ffffff', 0.35),
    hover: alpha(b.text, 0.045), 'hover-2': alpha(b.text, 0.08),
    // акцент (исторические имена --green* — это акцент, не «зелёный»)
    green: acc, accent: acc, 'green-bright': mixHex(acc, '#ffffff', 0.3), 'green-dim': mixHex(acc, b.ground, 0.72),
    'accent-soft': alpha(acc, 0.14), 'border-accent': alpha(acc, 0.4), 'accent-contrast': b.ground, 'accent-glow': alpha(acc, 0.45),
    // состояния
    warn: s.warn, 'warn-t': mixHex(s.warn, '#ffffff', 0.15), 'warn-soft': alpha(s.warn, 0.14), 'warn-ring': alpha(s.warn, 0.24),
    ok: s.ok, 'ok-soft': alpha(s.ok, 0.14), add: s.ok, star: s.warn,
    danger: s.danger, 'danger-soft': alpha(s.danger, 0.14), info: '#7aa2f7',
    // форма
    radius: look.r + 'px', r2: Math.round(look.r * 0.62) + 'px', r3: Math.round(look.r * 0.5) + 'px', 'row-h': look.row + 'px',
    'card-shadow': 'none', 'card-active-bg': b.raised, 'card-active-shadow': 'none',
    shadow: '0 14px 44px rgba(0,0,0,.5), 0 2px 8px rgba(0,0,0,.3)',
  };
  for (const [k, v] of Object.entries(look.over)) t[k] = v;
  return t;
}

// Применить тему к окну: все токены — переменными на :root (перебивают значения по умолчанию из styles.css).
export function applyLook(settings, root = (typeof document !== 'undefined' ? document.documentElement : null)) {
  if (!root) return;
  const tok = lookTokens(lookOf(settings));
  for (const [k, v] of Object.entries(tok)) root.style.setProperty('--' + k, v);
}

// Цвета ANSI терминала — общие; фон/текст/курсор/выделение берутся из палитры.
export const TERM_THEME = {
  background: '#0e0e10', foreground: '#d4d4d8', cursor: '#3ecf8e',
  selectionBackground: '#1f3a30',
  black: '#0e0e10', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
  blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
};
// xterm-тема для настроек окна (фон терминала = фон окна: терминал «лежит» прямо на нём).
// glass — терминал на полупрозрачном фоне окна: свой фон прозрачный (xterm с allowTransparency), сквозь
// него виден фон окна или карточки, в которой он стоит. Так рисуют и редактор, и окна модулей.
export function termThemeFor(settings, { glass = false } = {}) {
  const l = lookOf(settings), tok = lookTokens(l);
  return {
    ...TERM_THEME,
    background: glass ? '#00000000' : tok.bg, foreground: tok.text2, cursor: l.accent, cursorAccent: tok.bg,
    selectionBackground: mixHex(l.accent, tok.bg, 0.7), black: tok.bg,
  };
}
export const THEME_NAME = 'graphite';
