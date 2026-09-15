#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_host="${MIA_SOURCE_HOST:-root@188.245.245.213}"
target_host="${MIA_DE_ROMA_HOST:-root@116.203.216.59}"
ssh_jump="${MIA_DE_ROMA_SSH_JUMP:-roma-prod}"
target_env="${MIA_DE_ROMA_ENV:-/etc/mia/mia.env}"
temporary_secret="$(mktemp)"
temporary_env="$(mktemp)"

cleanup() {
  chmod 600 "$temporary_secret" "$temporary_env" 2>/dev/null || true
  if command -v shred >/dev/null; then
    shred -u "$temporary_secret" "$temporary_env" 2>/dev/null || true
  else
    rm -f "$temporary_secret" "$temporary_env"
  fi
}
trap cleanup EXIT
chmod 600 "$temporary_secret" "$temporary_env"

cd "$repository_root"
git_sha="$(git rev-parse HEAD)"
[[ "$(git branch --show-current)" == "main" ]] || { echo "Preparation must run from Mia main." >&2; exit 1; }
git diff --quiet && git diff --cached --quiet && [[ -z "$(git ls-files --others --exclude-standard)" ]] || {
  echo "Preparation requires a clean Mia worktree." >&2
  exit 1
}
[[ "$(git ls-remote origin refs/heads/main | awk '{print $1}')" == "$git_sha" ]] || {
  echo "GitHub Mia main does not match local HEAD." >&2
  exit 1
}

ssh -o BatchMode=yes "$source_host" 'docker exec -i apimaster-new-api-postgres sh -s' > "$temporary_secret" <<'REMOTE'
psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At <<'SQL'
SELECT value FROM options WHERE key = 'TelegramWebhookSecret' LIMIT 1;
SQL
REMOTE
webhook_secret="$(tr -d '\r\n' < "$temporary_secret")"
if (( ${#webhook_secret} < 32 || ${#webhook_secret} > 256 )) ||
  ! LC_ALL=C grep -Eq '^[A-Za-z0-9_-]+$' <<< "$webhook_secret"; then
  echo "APIMaster Telegram webhook secret is missing or invalid." >&2
  exit 1
fi

scp -q -o "ProxyJump=$ssh_jump" "$target_host:$target_env" "$temporary_env"
for assignment in \
  'MIA_PUBLIC_BASE_URL=https://mia.apimaster.ai' \
  "TELEGRAM_WEBHOOK_SECRET=$webhook_secret"; do
  key="${assignment%%=*}"
  value="${assignment#*=}"
  next_env="$(mktemp)"
  chmod 600 "$next_env"
  awk -F= -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    $1 == key { print key "=" value; replaced = 1; next }
    { print }
    END { if (!replaced) print key "=" value }
  ' "$temporary_env" > "$next_env"
  mv "$next_env" "$temporary_env"
done
scp -q -o "ProxyJump=$ssh_jump" "$temporary_env" "$target_host:/tmp/mia-direct.env"
ssh -J "$ssh_jump" -o BatchMode=yes "$target_host" \
  "install -m 600 -o roma -g roma /tmp/mia-direct.env '$target_env' && rm -f /tmp/mia-direct.env"

echo "Mia direct-entry environment prepared on $target_host for GitHub SHA $git_sha."
