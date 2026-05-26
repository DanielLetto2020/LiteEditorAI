# Участие в разработке

Спасибо за интерес к LiteEditorAI! Проект на стадии **alpha** — баги и предложения приветствуются.

## Баг-репорты и идеи

Открывай [Issue](https://github.com/DanielLetto2020/LiteEditorAI/issues): что ожидал, что произошло,
ОС и версия (видна в меню «О программе»), по возможности — скриншот или вывод DevTools (`F12`).

## Сборка и запуск

```bash
npm install        # зависимости + сборка node-pty под Electron (postinstall)
npm start          # собрать фронт и запустить
npm run watch      # esbuild в watch-режиме для фронта
```

Требуется Node.js 18+ (x64, Linux или Windows).

## Архитектура (кратко)

- **`main.js`** — тонкий Electron-бэкенд: PTY, файловые операции, git, окно. НЕ бандлится.
- **`preload.js`** — мост `window.lite` через `contextBridge` (contextIsolation вкл., nodeIntegration выкл.).
- **`renderer/renderer.js`** — вся логика UI, бандлится esbuild (`node build.js`).
- Состояние — в `~/.LiteEditorAI/` (проекты, настройки, заметки).

Правки `main.js`/`preload.js` применяются на следующем запуске; правки `renderer.js` требуют пересборки
(`npm start` пересобирает сам).

## Pull requests

- Небольшие сфокусированные PR проще ревьюить.
- Стиль — как в окружающем коде (без линтера в проекте).
- В проекте нет тестов; перед PR прогоняй сборку (`node build.js`) и проверь руками.

## Лицензия

Внося вклад, ты соглашаешься, что он распространяется под [Apache License 2.0](LICENSE).
