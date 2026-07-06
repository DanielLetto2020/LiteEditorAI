// Рамка окна — тонкий бордер по периметру ВСЕГО окна (редактор и каждое окно модуля),
// чтобы тёмное окно на тёмном фоне оставалось различимым, не становясь акцентом.
// Общий реестр оттенков и применение — разделяются renderer.js и module-entry.js
// (как themes.js). CSS-часть — body.win-frame::after в styles.css.
//
// Настройки (settings.*): frameOn (вкл, дефолт true) · frameColor (ключ FRAME_COLORS,
// дефолт 'green') · framePulse (дыхание цвета c1→c2→c1, дефолт true) · framePeriodS
// (период пульсации в секундах, 2..30, дефолт 6). Окна модулей получают изменения
// живьём через шину app:settingsChanged.
export const FRAME_COLORS = {
  green:    { label: 'Тёмно-зелёный', c1: '#1e4d33', c2: '#35855a' },
  teal:     { label: 'Бирюзовый',     c1: '#14504c', c2: '#23867e' },
  blue:     { label: 'Тёмно-синий',   c1: '#1d3f66', c2: '#2f68ab' },
  indigo:   { label: 'Индиго',        c1: '#2e2b63', c2: '#4c48a6' },
  violet:   { label: 'Фиолетовый',    c1: '#46265c', c2: '#763f99' },
  crimson:  { label: 'Бордовый',      c1: '#5c2231', c2: '#99394f' },
  amber:    { label: 'Янтарный',      c1: '#5c481f', c2: '#987933' },
  graphite: { label: 'Графитовый',    c1: '#3d4148', c2: '#6b7280' },
};
export const DEFAULT_FRAME_COLOR = 'green';

// Нормализованный конфиг рамки из settings (окна модулей держат settings без merge
// с DEFAULT_SETTINGS редактора, поэтому дефолты зашиты здесь).
export function frameConf(s) {
  s = s || {};
  const color = FRAME_COLORS[s.frameColor] ? s.frameColor : DEFAULT_FRAME_COLOR;
  return {
    on: s.frameOn !== false,
    color,
    pulse: s.framePulse !== false,
    periodS: Math.max(2, Math.min(30, Number(s.framePeriodS) || 6)),
    ...FRAME_COLORS[color],
  };
}

export function applyFrame(settings) {
  const c = frameConf(settings);
  const b = document.body;
  b.classList.toggle('win-frame', c.on);
  b.classList.toggle('win-frame-pulse', c.on && c.pulse);
  b.style.setProperty('--frame-c1', c.c1);
  b.style.setProperty('--frame-c2', c.c2);
  b.style.setProperty('--frame-period', c.periodS + 's');
}
