#!/usr/bin/env bash
set -Eeuo pipefail

target_host="${MIA_DE_ROMA_HOST:-root@116.203.216.59}"
ssh_jump="${MIA_DE_ROMA_SSH_JUMP:-roma-prod}"
expected_url="https://mia.apimaster.ai/telegram/webhook"

ssh -J "$ssh_jump" -o BatchMode=yes "$target_host" "EXPECTED_WEBHOOK_URL='$expected_url' bash -s" <<'REMOTE'
set -Eeuo pipefail
env_file="${MIA_ENV:-/etc/mia/mia.env}"
[[ -f "$env_file" ]] || { echo "Mia environment file is missing." >&2; exit 1; }

read_env() {
  local key="$1"
  sed -n "s/^${key}=//p" "$env_file" | tail -n 1
}

bot_token="$(read_env TELEGRAM_BOT_TOKEN)"
webhook_secret="$(read_env TELEGRAM_WEBHOOK_SECRET)"
[[ -n "$bot_token" ]] || { echo "TELEGRAM_BOT_TOKEN is missing." >&2; exit 1; }
if (( ${#webhook_secret} < 32 || ${#webhook_secret} > 256 )) ||
  ! LC_ALL=C grep -Eq '^[A-Za-z0-9_-]+$' <<< "$webhook_secret"; then
  echo "TELEGRAM_WEBHOOK_SECRET is invalid." >&2
  exit 1
fi
curl -fsS http://172.20.0.1:3010/health >/dev/null
curl -fsS https://mia.apimaster.ai/health >/dev/null

response="$(curl -fsS -X POST "https://api.telegram.org/bot${bot_token}/setWebhook" \
  --data-urlencode "url=$EXPECTED_WEBHOOK_URL" \
  --data-urlencode "secret_token=$webhook_secret" \
  --data-urlencode 'allowed_updates=["message","edited_message","callback_query","inline_query"]' \
  --data-urlencode 'drop_pending_updates=false')"
node -e 'if (JSON.parse(process.argv[1]).ok !== true) process.exit(1)' "$response"

info="$(curl -fsS "https://api.telegram.org/bot${bot_token}/getWebhookInfo")"
pending="$(node -e '
  const data = JSON.parse(process.argv[1]);
  if (data.ok !== true || data.result?.url !== process.argv[2] || data.result?.last_error_message) process.exit(1);
  process.stdout.write(String(data.result?.pending_update_count ?? 0));
' "$info" "$EXPECTED_WEBHOOK_URL")"
echo "Telegram webhook now points to $EXPECTED_WEBHOOK_URL; pending_update_count=$pending."
REMOTE
