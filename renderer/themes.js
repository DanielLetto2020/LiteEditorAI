// Theme registry shared by the editor (renderer.js) and module windows (module-entry.js).
// CSS does the heavy lifting via body[data-theme] (token contract in styles.css); here we carry
// the human label + per-theme terminal (xterm) colours. To add a theme: add a block in styles.css
// AND an entry here. Default = neumorphism.
export const TERM_THEME = {
  background: '#0d1116', foreground: '#cdd6e0', cursor: '#34d399',
  selectionBackground: '#1f3a4d',
  black: '#0d1116', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
  blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
};
export const DEFAULT_THEME = 'neumorphism';
export const THEMES = {
  neumorphism: { label: 'Неоморфизм', term: { background: '#161a20', foreground: '#cfd4db', cursor: '#34d399', selectionBackground: '#1f3a30' } },
  glass:       { label: 'Стекло',     term: { background: '#0b0f16', foreground: '#dbe5ee', cursor: '#5eead4', selectionBackground: '#13443c' } },
  material:    { label: 'Material',   term: { background: '#121212', foreground: '#e0e0e0', cursor: '#26a69a', selectionBackground: '#004d40' } },
  catppuccin:  { label: 'Catppuccin', term: { background: '#181825', foreground: '#cdd6f4', cursor: '#a6e3a1', selectionBackground: '#333b54' } },
  gruvbox:     { label: 'Gruvbox',    term: { background: '#282828', foreground: '#ebdbb2', cursor: '#fabd2f', selectionBackground: '#504945' } },
  aurora:      { label: 'Aurora',     term: { background: '#0a0f14', foreground: '#dbe7f0', cursor: '#2dd4bf', selectionBackground: '#0f4a44' } },
};
// Merged xterm theme for a given settings.theme name.
export function termThemeFor(themeName) {
  const t = THEMES[themeName] || THEMES[DEFAULT_THEME];
  return { ...TERM_THEME, ...t.term };
}
