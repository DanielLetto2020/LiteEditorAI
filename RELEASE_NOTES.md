**LiteEditorAI v1.1.29** — лёгкий редактор для работы с ИИ-агентами в терминале.

Полировка вивера после крупного обновления Git/IDE из v1.1.28.

## 🐛 Исправлено
- **Выпадашка веток** — нечитаемые символы-стрелки у папок-групп заменены на нормальные иконки-шевроны.
- **История Git** — длинные названия коммитов теперь переносятся на новую строку, а не вылезают за блок справа.

### ⬇️ Что скачать
- 🐧 **`.deb`** — Ubuntu / Debian (x64): `sudo apt install ./LiteEditorAI_*.deb`, затем иконка **LiteEditorAI** в меню.
- 🪟 **`.zip`** (win) — Windows (x64), portable: распакуйте и запустите `LiteEditorAI.exe` (установка не нужна).
- 🍎 **`.dmg`** — macOS: `-arm64` для Apple Silicon, `-x64` для Intel. Сборка без подписи Apple — при первом
  запуске снимите карантин: `xattr -dr com.apple.quarantine /Applications/LiteEditorAI.app`.
- 🤖 **`liteeditor-pult-0.60.0-debug.apk`** — пульт для Android (без изменений в этом релизе).

> Alpha: терминалы не переживают перезапуск редактора. Баги и идеи — в [Issues](https://github.com/DanielLetto2020/LiteEditorAI/issues).
