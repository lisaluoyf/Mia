#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${CONFIRM_MIA_CUTOVER:-}" != "YES" ]]; then
  echo "Set CONFIRM_MIA_CUTOVER=YES to perform the production cutover." >&2
  exit 2
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_host="${MIA_SOURCE_HOST:-root@188.245.245.213}"
target_host="${MIA_DE_ROMA_HOST:-root@116.203.216.59}"
ssh_jump="${MIA_DE_ROMA_SSH_JUMP:-roma-prod}"
ssh_options=(-J "$ssh_jump" -o BatchMode=yes -o ConnectTimeout=20)
cutover_id="$(date -u +%Y%m%dT%H%M%SZ)"
git_sha="$(git -C "$repository_root" rev-parse HEAD)"
temporary_env="$(mktemp)"
old_stopped=0
target_started=0
apimaster_switched=0

cleanup() {
  chmod 600 "$temporary_env" 2>/dev/null || true
  if command -v shred >/dev/null; then shred -u "$temporary_env" 2>/dev/null || true; else rm -f "$temporary_env"; fi
}

source_ssh() { ssh "${ssh_options[@]}" "$source_host" "$@"; }
target_ssh() { ssh "${ssh_options[@]}" "$target_host" "$@"; }

rollback() {
  status=$?
  trap - ERR
  echo "Mia cutover failed; starting rollback for $cutover_id." >&2
  if [[ "$apimaster_switched" -eq 1 ]]; then
    ssh "${ssh_options[@]}" "$source_host" "bash -s -- '$cutover_id'" \
      < "$repository_root/scripts/rollback-apimaster-from-de-roma.sh" || true
  fi
  if [[ "$target_started" -eq 1 ]]; then
    target_ssh "sudo -u roma -H bash -lc 'cd /srv/mia && pm2 stop mia >/dev/null 2>&1 || true'" || true
  fi
  if [[ "$old_stopped" -eq 1 ]]; then
    source_ssh "sudo -u roma -H bash -lc 'pm2 delete mia >/dev/null 2>&1 || true; cd /srv/mia/current && pm2 start ecosystem.config.cjs --update-env && pm2 save'" || true
  fi
  cleanup
  exit "$status"
}
trap rollback ERR
trap cleanup EXIT

cd "$repository_root"
[[ "$(git branch --show-current)" == "main" ]] || { echo "Cutover must run from main." >&2; exit 1; }
git diff --quiet && git diff --cached --quiet && [[ -z "$(git ls-files --others --exclude-standard)" ]] || {
  echo "Cutover requires a clean Git worktree." >&2
  exit 1
}
[[ "$(git ls-remote origin refs/heads/main | awk '{print $1}')" == "$git_sha" ]] || {
  echo "GitHub main does not match local HEAD." >&2
  exit 1
}

source_ssh "sudo -u roma -H bash -lc 'test \"\$(pm2 pid mia | tail -n1)\" -gt 0'"
target_ssh "grep -q '\"git_sha\": \"$git_sha\"' /srv/mia/current/release.json"
target_ssh "grep -q 'BEGIN MIA DE-ROMA ROUTES' /root/romaapi.com/caddy/Caddyfile.hub"
curl -fsS https://apimaster.ai/mia/ >/dev/null

scp -o "ProxyJump=$ssh_jump" "$source_host:/etc/mia/mia.env" "$temporary_env"
chmod 600 "$temporary_env"
for assignment in \
  'APIMASTER_BASE_URL=https://apimaster.ai' \
  'APIMASTER_INTERNAL_BASE_URL=https://apimaster.ai' \
  'APIMASTER_IDENTITY_BASE_URL=https://apimaster.ai' \
  'HOST=172.20.0.1' \
  'PORT=3010' \
  'DATABASE_PATH=/var/lib/mia/mia.sqlite' \
  'MIA_PUBLIC_BASE_URL=https://apimaster.ai'; do
  key="${assignment%%=*}"
  value="${assignment#*=}"
  next_env="$(mktemp)"
  awk -F= -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    $1 == key { print key "=" value; replaced = 1; next }
    { print }
    END { if (!replaced) print key "=" value }
  ' "$temporary_env" > "$next_env"
  mv "$next_env" "$temporary_env"
  chmod 600 "$temporary_env"
done
scp -o "ProxyJump=$ssh_jump" "$temporary_env" "$target_host:/tmp/mia.env.$cutover_id"
target_ssh "install -m 600 -o roma -g roma '/tmp/mia.env.$cutover_id' /etc/mia/mia.env && rm -f '/tmp/mia.env.$cutover_id'"

source_ssh "sudo -u roma -H bash -lc 'pm2 stop mia'"
old_stopped=1

target_ssh "if [ -d /var/lib/mia ] && [ -n \"\$(find /var/lib/mia -mindepth 1 -maxdepth 1 -print -quit)\" ]; then mv /var/lib/mia '/var/lib/mia.pre-$cutover_id'; fi; install -d -m 700 -o roma -g roma /var/lib/mia"
source_ssh "tar -C /var/lib/mia -cpf - ." | target_ssh "tar -C /var/lib/mia -xpf - && chown -R roma:roma /var/lib/mia"

target_ssh "sudo -u roma -H bash -lc 'cd /srv/mia && pm2 delete mia >/dev/null 2>&1 || true; cd /srv/mia/current && pm2 start ecosystem.config.cjs --update-env && pm2 save'"
target_started=1
target_ssh "for attempt in \$(seq 1 20); do curl -fsS http://172.20.0.1:3010/health >/dev/null && exit 0; sleep 1; done; exit 1"
curl -fsS https://de-api.romaapi.com/mia-internal/health >/dev/null

apimaster_switched=1
ssh "${ssh_options[@]}" "$source_host" "bash -s -- '$cutover_id'" \
  < "$repository_root/scripts/switch-apimaster-to-de-roma.sh"

trap - ERR
curl -fsS https://apimaster.ai/mia/ >/dev/null ||
  echo "Warning: de-roma is live, but the public Mia page health check failed." >&2
source_ssh 'active_port=$(sed -n '\''/upstream newapi_backend/,/}/ s/.*127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p'\'' /etc/nginx/conf.d/newapi-bluegreen.conf); case "$active_port" in 3002) active_container=apimaster-new-api-blue ;; 3003) active_container=apimaster-new-api-green ;; *) exit 1 ;; esac; for container in apimaster-new-api-worker "$active_container"; do docker inspect "$container" --format '\''{{range .Config.Env}}{{println .}}{{end}}'\'' | grep -q '\''^MIA_TELEGRAM_WEBHOOK_URL=https://de-api.romaapi.com/mia-internal/telegram/update$'\''; done' ||
  echo "Warning: de-roma is live, but APIMaster webhook configuration needs manual verification." >&2
source_ssh "sudo -u roma -H bash -lc 'pm2 delete mia && pm2 save'" ||
  echo "Warning: de-roma is live, but the stopped source PM2 entry still needs cleanup." >&2
cleanup
trap - EXIT
echo "Mia cutover complete: sha=$git_sha target=$target_host cutover_id=$cutover_id"
