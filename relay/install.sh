#!/usr/bin/env bash
# Установка self-hosted релея LiteEditor «под ключ».
# Скопируйте папку relay/ на свой VPS и запустите:  bash install.sh
#
# Скрипт: подберёт docker/podman, спросит домен и email, сгенерирует секрет,
# создаст .env (если его ещё нет) и поднимет релей + Caddy (авто-HTTPS).
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\033[36m%s\033[0m\n' "$*"; }
err() { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# --- 1. Подобрать команду compose (docker или podman) ------------------------
COMPOSE=""
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
  COMPOSE="podman compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
elif command -v podman-compose >/dev/null 2>&1; then
  COMPOSE="podman-compose"
else
  err "Не найден ни docker, ни podman с поддержкой compose."
  err "Установите Docker (https://docs.docker.com/engine/install/) или Podman и повторите."
  exit 1
fi
say "Использую: $COMPOSE"

# --- 2. Сгенерировать секрет ------------------------------------------------
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

# --- 3. Создать .env (если ещё нет) -----------------------------------------
if [ -f .env ]; then
  say ".env уже существует — использую его (домен/секрет не меняю)."
else
  say "Первичная настройка. Введите параметры релея:"
  read -rp "  Домен релея (например relay.example.com): " RELAY_DOMAIN
  read -rp "  Email для Let's Encrypt: " RELAY_ACME_EMAIL
  if [ -z "${RELAY_DOMAIN:-}" ] || [ -z "${RELAY_ACME_EMAIL:-}" ]; then
    err "Домен и email обязательны."; exit 1
  fi
  read -rp "  Требовать одобрение пультов на ПК? (рекомендуется) [Y/n]: " PAIR
  case "${PAIR:-Y}" in [Nn]*) REQUIRE_PAIRING=0 ;; *) REQUIRE_PAIRING=1 ;; esac

  SECRET="$(gen_secret)"
  cat > .env <<EOF
RELAY_DOMAIN=${RELAY_DOMAIN}
RELAY_ACME_EMAIL=${RELAY_ACME_EMAIL}
RELAY_SECRET=${SECRET}
RELAY_REQUIRE_PAIRING=${REQUIRE_PAIRING}
EOF
  chmod 600 .env
  say "Создан .env (секрет сгенерирован автоматически)."
fi

# Прочитать домен из .env для финальной подсказки.
RELAY_DOMAIN="$(grep -E '^RELAY_DOMAIN=' .env | cut -d= -f2-)"

# --- 4. Поднять стек --------------------------------------------------------
say "Собираю и запускаю релей + Caddy…"
$COMPOSE up -d --build

# --- 5. Проверка ------------------------------------------------------------
echo
say "Готово. Проверьте через минуту (Caddy выпускает сертификат):"
echo "  curl https://${RELAY_DOMAIN}/health      # должно вернуть: ok"
echo
say "Дальше:"
echo "  1. В редакторе (меню «Пульт») укажите хост: ${RELAY_DOMAIN}, зарегистрируйте аккаунт."
echo "  2. В пульте на экране входа укажите тот же хост и войдите тем же логином/паролем."
echo
echo "Логи:        $COMPOSE logs -f relay"
echo "Перезапуск:  $COMPOSE restart relay   (аккаунты в ./data сохраняются)"
echo "Остановить:  $COMPOSE down"
