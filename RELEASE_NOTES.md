**LiteEditorAI v1.0.96** — лёгкий редактор для работы с ИИ-агентами в терминале.

### ✨ Добавлено
- **Выбор оболочки терминала** в Настройках ([#2](https://github.com/DanielLetto2020/LiteEditorAI/issues/2)).
  На **Windows** по умолчанию теперь **PowerShell** (PowerShell 7, если установлен, иначе Windows
  PowerShell) с загрузкой вашего `$PROFILE` (алиасы/функции работают) — плюс можно выбрать `cmd` или указать
  свой путь. На **Linux** — `bash` по умолчанию или свой путь (zsh/fish/…). Раньше на Windows всегда
  запускался `cmd`. Спасибо @Eurgen за детальный разбор.

### 🛰 Удалённый пульт (Android)
- Без изменений (та же версия APK) — управляй редактором с планшета: терминал, проекты, файлы, **одобрение
  устройства на ПК**. Как подключить — в [README](https://github.com/DanielLetto2020/LiteEditorAI#удалённый-пульт-android).

### ⬇️ Что скачать
- 🐧 **`.deb`** — Ubuntu / Debian (x64): `sudo apt install ./liteeditor-ai_*.deb`, затем иконка **LiteEditorAI** в меню.
- 🪟 **`.zip`** — Windows (x64), portable: распакуй и запусти `LiteEditorAI.exe` (установка не нужна).
- 🤖 **`liteeditor-pult-*.apk`** — пульт для Android: установи на устройство (разреши установку из неизвестных источников).

> Alpha: терминалы не переживают перезапуск. Баги и идеи — в [Issues](https://github.com/DanielLetto2020/LiteEditorAI/issues).
