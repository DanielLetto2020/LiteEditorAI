**LiteEditorAI v1.0.196** — лёгкий редактор для работы с ИИ-агентами в терминале.

Исправление сборки под **macOS на процессорах Intel**.

## 🐛 Исправлено
- **Терминал на Intel-маках.** В сборке для Intel (x64) терминал не запускался — в пакет попадал нативный
  компонент терминала, собранный под Apple Silicon. Теперь каждая архитектура macOS собирается на своём
  раннере, и терминал работает и на Intel, и на Apple Silicon.

### ⬇️ Что скачать
- 🐧 **`.deb`** — Ubuntu / Debian (x64): `sudo apt install ./LiteEditorAI_*.deb`, затем иконка **LiteEditorAI** в меню.
- 🪟 **`.zip`** (win) — Windows (x64), portable: распакуйте и запустите `LiteEditorAI.exe` (установка не нужна).
- 🍎 **`.dmg`** — macOS: `-arm64` для Apple Silicon, `-x64` для Intel. Сборка без подписи Apple — при первом
  запуске снимите карантин: `xattr -dr com.apple.quarantine /Applications/LiteEditorAI.app`.
- 🤖 **`liteeditor-pult-*.apk`** — пульт для Android (без изменений с прошлого релиза).

> Alpha: терминалы не переживают перезапуск редактора. Баги и идеи — в [Issues](https://github.com/DanielLetto2020/LiteEditorAI/issues).
