#!/usr/bin/env bash
set -Eeuo pipefail

cutover_id="${1:-}"
[[ "$cutover_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || {
  echo "usage: switch-apimaster-to-de-roma.sh <YYYYMMDDTHHMMSSZ>" >&2
  exit 2
}
[[ "$(id -u)" -eq 0 ]] || { echo "This script must run as root on APIMaster." >&2; exit 1; }

newapi_root="/opt/newapi"
mia_env="$newapi_root/.env.mia"
nginx_config="/etc/nginx/sites-enabled/apimaster.ai"
bluegreen_config="/etc/nginx/conf.d/newapi-bluegreen.conf"
webhook_url="https://de-api.romaapi.com/mia-internal/telegram/update"
backup_root="/var/backups/mia-cutover/$cutover_id"
env_backup="$backup_root/apimaster.env.mia"
nginx_backup="$backup_root/apimaster.nginx"
active_service_file="$backup_root/active-service"

[[ -f "$mia_env" && -f "$nginx_config" && -f "$bluegreen_config" ]] || {
  echo "APIMaster runtime config is missing." >&2
  exit 1
}

active_port="$(sed -n '/upstream newapi_backend/,/}/ s/.*127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' "$bluegreen_config")"
case "$active_port" in
  3002) active_service="new-api-blue"; active_container="apimaster-new-api-blue" ;;
  3003) active_service="new-api-green"; active_container="apimaster-new-api-green" ;;
  *) echo "Could not identify the active NewAPI color from port: ${active_port:-missing}." >&2; exit 1 ;;
esac

install -d -m 700 "$backup_root"
cp -a "$mia_env" "$env_backup"
cp -a "$nginx_config" "$nginx_backup"
printf '%s\n' "$active_service" > "$active_service_file"

temporary_env="$(mktemp)"
awk -F= -v value="$webhook_url" '
  BEGIN { replaced = 0 }
  $1 == "MIA_TELEGRAM_WEBHOOK_URL" { print "MIA_TELEGRAM_WEBHOOK_URL=" value; replaced = 1; next }
  { print }
  END { if (!replaced) print "MIA_TELEGRAM_WEBHOOK_URL=" value }
' "$mia_env" > "$temporary_env"
cat "$temporary_env" > "$mia_env"
rm -f "$temporary_env"

old_proxy_count="$(grep -cF 'proxy_pass http://172.17.0.1:3010;' "$nginx_config" || true)"
if [[ "$old_proxy_count" -ne 3 ]]; then
  cp -a "$env_backup" "$mia_env"
  echo "Expected exactly 3 local Mia proxy blocks, found $old_proxy_count." >&2
  exit 1
fi

temporary_nginx="$(mktemp)"
awk '
  /proxy_pass http:\/\/172\.17\.0\.1:3010;/ {
    indent = substr($0, 1, index($0, "p") - 1)
    print indent "proxy_pass https://de-api.romaapi.com;"
    print indent "proxy_ssl_server_name on;"
    print indent "proxy_ssl_name de-api.romaapi.com;"
    in_mia_proxy = 1
    next
  }
  in_mia_proxy && /proxy_set_header Host \$host;/ {
    indent = substr($0, 1, index($0, "p") - 1)
    print indent "proxy_set_header Host de-api.romaapi.com;"
    in_mia_proxy = 0
    next
  }
  { print }
' "$nginx_config" > "$temporary_nginx"
cat "$temporary_nginx" > "$nginx_config"
rm -f "$temporary_nginx"

if [[ "$(grep -cF 'proxy_pass https://de-api.romaapi.com;' "$nginx_config" || true)" -ne 3 ]]; then
  cp -a "$env_backup" "$mia_env"
  cp -a "$nginx_backup" "$nginx_config"
  echo "Failed to rewrite all Mia proxy blocks." >&2
  exit 1
fi

if ! nginx -t; then
  cp -a "$env_backup" "$mia_env"
  cp -a "$nginx_backup" "$nginx_config"
  echo "Nginx validation failed; APIMaster configuration was restored." >&2
  exit 1
fi

cd "$newapi_root"
docker compose up -d --no-build --pull never --force-recreate new-api-worker "$active_service"
nginx -s reload

for container in apimaster-new-api-worker "$active_container"; do
  configured="$(docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' |
    sed -n 's/^MIA_TELEGRAM_WEBHOOK_URL=//p')"
  [[ "$configured" == "$webhook_url" ]] || {
    echo "$container did not load the de-roma webhook URL." >&2
    exit 1
  }
done

echo "APIMaster now forwards Mia traffic to de-roma; active=$active_service cutover_id=$cutover_id"
