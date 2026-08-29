// Линтер — гейт `style` из .claude/gauntlet.json. Запуск: npm run lint
//
// Проект разделён на две среды, и глобалы у них разные:
//   • бэкенд (main/preload/remote/lib/scripts/test/mcp) — Node, CommonJS;
//   • фронт (renderer/**, кроме собранного dist) — браузер, ESM (бандлится esbuild).
// Единый конфиг на оба слоя дал бы ложные no-undef: `require` в браузерном блоке
// или `window` в Node.

const js = require('@eslint/js');
const globals = require('globals');

// Отступления от eslint:recommended, продиктованные стилем проекта.
// Без них линтер даёт 1249 замечаний на идиомы, которые здесь применяются осознанно,
// и тонет реальная находка — а именно ради неё гейт и нужен.
const PROJECT_STYLE = {
  // `try { … } catch (_) {}` — основной способ не дать необязательной операции
  // уронить обработчик. Пустой catch тут намеренный, а не забытый.
  'no-empty': ['error', { allowEmptyCatch: true }],
  // Не считаем «неиспользуемым» пойманное исключение и аргументы с префиксом _:
  // в колбэках IPC сигнатура задана снаружи, лишний параметр убрать нельзя.
  'no-unused-vars': ['error', {
    caughtErrors: 'none',
    args: 'after-used',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
  }],
  // Управляющие символы в регулярках — предмет работы редактора, а не опечатка:
  // разбор вывода PTY требует матчить ESC (\x1b) и BEL (\x07) в SGR/OSC-последовательностях.
  'no-control-regex': 'off',
  // Классы из нулевой ширины (ZWSP/ZWJ/BOM) в чистке текста намеренны. allowEscape разрешает их
  // только когда символ записан escape-последовательностью: буквальный невидимый символ
  // в исходнике по-прежнему ошибка — его в коде не видно и правится он вслепую.
  'no-misleading-character-class': ['error', { allowEscape: true }],
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'renderer/dist/**',     // вывод esbuild
      'dist-release/**',
      'release/**',
      'reports/**',           // отчёт Stryker
      '.stryker-tmp/**',
      'landing/**',
      'ansible/**',
    ],
  },

  // --- Бэкенд: Node + CommonJS ------------------------------------------------
  {
    files: ['*.js', 'lib/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'mcp/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: { ...js.configs.recommended.rules, ...PROJECT_STYLE },
  },

  // --- Фронт: браузер + ESM ---------------------------------------------------
  {
    files: ['renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: { ...js.configs.recommended.rules, ...PROJECT_STYLE },
  },
];
