#!/usr/bin/env bash
# Сборка debug APK пульта LiteEditor через podman. На хост НЕ нужен Android SDK —
# нужны только podman + node (для бандла UI). Подход скопирован из FamilyTracker.
#
# Шаги:
#   0) Бандл UI пульта (renderer/mobile.js + xterm) → app/src/main/assets/ (node/esbuild на хосте).
#   1) Первый запуск — генерим gradle wrapper из официального gradle-образа.
#   2) Сборка APK в образе с Android SDK 34 (через wrapper).
#   3) Готовый APK → ../release/android/liteeditor-pult-<version>-debug.apk
#
# Кеш Gradle ~/.gradle мапится в .gradle-cache/ — повторные сборки не качают зависимости.
set -euo pipefail
cd "$(dirname "$0")"

REPO_ROOT="$(cd .. && pwd)"
GRADLE_IMAGE="docker.io/library/gradle:8.7-jdk17"
ANDROID_IMAGE="ghcr.io/cirruslabs/android-sdk:34"

mkdir -p .gradle-cache "$REPO_ROOT/release/android"

# Шаг 0: собрать ассеты UI (если есть node).
if command -v node >/dev/null 2>&1; then
  echo "==> Бандл UI пульта (esbuild)…"
  node "$REPO_ROOT/scripts/build-mobile.js"
else
  echo "!! node не найден на хосте — пропускаю бандл UI (убедись, что assets/app.js уже собран)"
fi

# Шаг 1: gradle wrapper при первом запуске.
if [ ! -f gradlew ]; then
  echo "==> Первый запуск: генерирую gradle wrapper (~5 минут на pull образа)…"
  podman run --rm \
    -v "$PWD:/work:Z" \
    -w /work \
    "$GRADLE_IMAGE" \
    gradle wrapper --gradle-version 8.7 --distribution-type bin
  chmod +x gradlew
fi

# Шаг 2: сборка APK.
echo "==> Сборка debug APK (первый запуск долгий — pull образа ~3 GB)…"
podman run --rm \
  -v "$PWD:/work:Z" \
  -v "$PWD/.gradle-cache:/root/.gradle:Z" \
  -w /work \
  "$ANDROID_IMAGE" \
  ./gradlew --no-daemon assembleDebug

APK_SRC="app/build/outputs/apk/debug/app-debug.apk"
if [ ! -f "$APK_SRC" ]; then
  echo "✗ APK не собрался — ожидался $APK_SRC"
  exit 1
fi

VERSION_NAME=$(grep -oP 'versionName = "\K[^"]+' app/build.gradle.kts)
DEST="$REPO_ROOT/release/android/liteeditor-pult-${VERSION_NAME}-debug.apk"
cp "$APK_SRC" "$DEST"
SIZE=$(du -h "$DEST" | cut -f1)

echo
echo "✓ APK готов: $DEST ($SIZE)"
echo "  Перекинь на планшет (Telegram «Избранное» / USB / HTTP) и установи."
