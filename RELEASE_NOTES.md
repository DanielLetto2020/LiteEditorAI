**LiteEditorAI v1.0.189** — лёгкий редактор для работы с ИИ-агентами в терминале.

Появились официальные сборки под **macOS** (Apple Silicon и Intel).

## ✨ Добавлено
- **Инсталлеры под macOS.** Теперь в релиз входят `.dmg` и `.zip` под две архитектуры: **`arm64`** (Apple
  Silicon, M1–M4) и **`x64`** (Intel). Собираются на `macos-latest` с нативным `node-pty` — терминал
  работает «из коробки».

### ⬇️ Что скачать
- 🐧 **`.deb`** — Ubuntu / Debian (x64): `sudo apt install ./LiteEditorAI_*.deb`, затем иконка **LiteEditorAI** в меню.
- 🪟 **`.zip`** (win) — Windows (x64), portable: распакуйте и запустите `LiteEditorAI.exe` (установка не нужна).
- 🍎 **`.dmg`** — macOS: `-arm64` для Apple Silicon, `-x64` для Intel. Сборка без подписи Apple — при первом
  запуске снимите карантин: `xattr -dr com.apple.quarantine /Applications/LiteEditorAI.app`.
- 🤖 **`liteeditor-pult-*.apk`** — пульт для Android (без изменений с прошлого релиза).

> Alpha: терминалы не переживают перезапуск редактора. Баги и идеи — в [Issues](https://github.com/DanielLetto2020/LiteEditorAI/issues).
