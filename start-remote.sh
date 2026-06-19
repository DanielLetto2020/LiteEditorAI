#!/usr/bin/env bash
# Запуск LiteEditor с включённым удалённым пультом (Android).
# Берёт токен из android/lite.properties (gitignored) — тот же, что вшит в APK.
# Запускать ИЗ ТЕРМИНАЛА: ./start-remote.sh   (иконка/лаунчер env не передают).
set -e
cd "$(dirname "$0")"

TOKEN=$(grep -oP '^TOKEN=\K.*' android/lite.properties 2>/dev/null || true)
RELAY_URL_CFG=$(grep -oP '^RELAY_URL=\K.*' android/lite.properties 2>/dev/null || true)
ROOM_CFG=$(grep -oP '^ROOM=\K.*' android/lite.properties 2>/dev/null || true)
if [ -z "$TOKEN" ]; then
  echo "✗ Не нашёл TOKEN в android/lite.properties"; exit 1
fi

export LITE_REMOTE=1
export LITE_RELAY_TOKEN="$TOKEN"
# Адрес релея берётся из android/lite.properties (gitignored) или из env LITE_RELAY_URL — НЕ хардкодим (приватный хост в публичный репозиторий не пишем).
export LITE_RELAY_URL="${LITE_RELAY_URL:-$RELAY_URL_CFG}"
export LITE_RELAY_ROOM="${LITE_RELAY_ROOM:-${ROOM_CFG:-default}}"
if [ -z "$LITE_RELAY_URL" ]; then
  echo "✗ Не задан RELAY_URL — укажи в android/lite.properties или env LITE_RELAY_URL"; exit 1
fi

echo "▶ LiteEditor + удалённый пульт"
echo "  релей: $LITE_RELAY_URL  комната: $LITE_RELAY_ROOM"
echo "  (открой хотя бы один проект/терминал, чтобы на планшете появилась вкладка)"
npm start
