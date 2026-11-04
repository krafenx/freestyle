#!/usr/bin/env bash
# scripts/tick.sh — «крон без GitHub»: будильник для любой всегда включённой машины
# (VPS, Raspberry Pi, домашний сервер, старый ноутбук).
#
# Установка (один раз):
#   chmod +x scripts/tick.sh
#   crontab -e
# и строка:
#   0 * * * *  TGCLOUD_TOKEN=app12345:xxxxx /полный/путь/vip-bot/scripts/tick.sh >> /tmp/vip-bot.log 2>&1
#
# Либо положи токен в ~/.config/vip-bot/token (chmod 600) — тогда в crontab
# просто:  0 * * * *  /полный/путь/vip-bot/scripts/tick.sh >> /tmp/vip-bot.log 2>&1
#
# Проверить руками:  ./scripts/tick.sh

set -euo pipefail

cd "$(dirname "$0")/.."

TOKEN_FILE="${HOME}/.config/vip-bot/token"
if [[ -z "${TGCLOUD_TOKEN:-}" && -f "${TOKEN_FILE}" ]]; then
  TGCLOUD_TOKEN="$(tr -d '[:space:]' < "${TOKEN_FILE}")"
fi

if [[ -z "${TGCLOUD_TOKEN:-}" ]]; then
  echo "ошибка: нет TGCLOUD_TOKEN (env или ${TOKEN_FILE})" >&2
  echo "токен берётся в @BotFather → ваш бот → Serverless → CLI Access" >&2
  exit 2
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "ошибка: не найден npx (нужен Node.js 18+)" >&2
  exit 3
fi

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] tick"
# --yes: не спрашивать про установку CLI в неинтерактивном окружении
exec npx --yes @tgcloud/cli@^0.2.0 run endpoints/tick
