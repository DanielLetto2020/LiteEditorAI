# Участие в разработке

Спасибо за интерес к **LiteEditorAI**! Проект находится в стадии **alpha** — баг-репорты, идеи и pull request'ы приветствуются.

## Баг-репорты и идеи

Откройте [Issue](https://github.com/DanielLetto2020/LiteEditorAI/issues): опишите, что ожидали, что произошло, ОС/дистрибутив и версию (видна в меню «Ещё → О программе»), а по возможности приложите скриншот или вывод DevTools (`F12`).

Если проблема связана с безопасностью или утечкой учётных данных — пожалуйста, сообщите приватно по инструкции в [SECURITY.md](SECURITY.md).

## Сборка, запуск и проверки

Требуется **Node.js 22+** (Linux x64) и сборочные инструменты для нативного `node-pty` (`python3`, `make`, `g++`).

```bash
npm install        # установка зависимостей + пересборка node-pty под Electron (postinstall)
npm start          # сборка фронта (esbuild) и запуск приложения
npm run watch      # esbuild в watch-режиме для фронта
```

Перед отправкой PR обязательно прогоните локальные гейты CI:

```bash
node build.js                     # сборка renderer/dist (бандлы + чанки модулей)
npm run lint                      # eslint .
npm run typecheck                 # tsc -p tsconfig.check.json
npm test                          # все модульные тесты (node --test test/*.test.js)
node scripts/i18n-extract.js --check  # полнота словарей locales/{en,zh}.json
```

> Если меняете строки русского UI в `renderer/`, `lib/`, `main.js` или `preload.js`, обновите словари командой `node scripts/i18n-extract.js` и дополните переводы в `locales/en.json` и `locales/zh.json`.

## Архитектура (кратко)

- **`main.js`, `lib/*.js`, `lib/ipc/*.js`, `lib/mcp/**/*.js`** — main-процесс Electron (PTY, стор `lib/store.js`, файловый вотчер, поиск, роутер модульных окон, Zero-Trust MCP Hub). **Не бандлятся** — правки применяются на следующем запуске.
- **`mcp/lite-mcp-bridge.js`** — лёгкий stdio ↔ Unix socket мост для CLI-агентов (распаковывается через `asarUnpack`).
- **`preload.js`** — единственный мост `window.lite` через `contextBridge` (`contextIsolation: true`, `nodeIntegration: false`, типы в `types/window-lite.d.ts`).
- **`renderer/`** — интерфейс главного окна (`renderer.js`) и модульных окон (`module-entry.js`, `renderer/modules/*.js`), стили в `renderer/styles/*.css`. **Бандлятся esbuild** (`node build.js`).
- **Пользовательские плагины:** спецификация API `ctx` v1 и примеры лежат в [`module-kit/`](module-kit/).
- **Состояние приложения:** `~/.LiteEditorAI/` (проекты, настройки, профили; ключи с секретами изолированы в `MAIN_ONLY_KEYS`).

## Pull requests

Прямой доступ к репозиторию (`write`/`collaborator`) не выдаётся и **не требуется** — участие идёт через форк:

1. **Сделайте форк** репозитория и создайте ветку от ветки **`contrib`**.
2. Внесите сфокусированные изменения и проверьте их перечисленными выше командами.
3. Откройте **pull request с базовой веткой `contrib`** — **не** в `main` и **не** в `dev`.

Почему `contrib`: `main` формируется как релизный снапшот (прямые коммиты туда перезаписываются при релизе), а `contrib` — публичная ветка для приёма внешних PR; принятые изменения мейнтейнер вручную переносит в разработку и выпускает в ближайших релизах.

Правила оформления PR:

- **Не меняйте версию** (`package.json`, `package-lock.json`, `APP_VERSION`) и релизные файлы (`CHANGELOG.md`, `RELEASE_NOTES.md`).
- **Никакого хардкода** цветов/теней/радиусов — только CSS-токены (`var(--…)`).
- **Локализация и чистота diff:** прогоните `lint`, `typecheck`, `test` и `i18n-extract.js --check`.
- **Никакой соавторской атрибуции ИИ** (`Co-Authored-By:` и аналогичных трейлеров).

## Лицензия

Внося вклад, вы соглашаетесь, что он распространяется под [Apache License 2.0](LICENSE) с сохранением уведомлений в [NOTICE](NOTICE).
