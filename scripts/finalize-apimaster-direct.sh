#!/usr/bin/env bash
set -Eeuo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "This script must run as root on APIMaster." >&2; exit 1; }
[[ "${CONFIRM_MIA_DIRECT_FINALIZE:-}" == "YES" ]] || {
  echo "Set CONFIRM_MIA_DIRECT_FINALIZE=YES to finalize Mia direct routing." >&2
  exit 2
}

newapi_root="/opt/newapi"
mia_env="$newapi_root/.env.mia"
nginx_config="/etc/nginx/sites-enabled/apimaster.ai"
bluegreen_config="/etc/nginx/conf.d/newapi-bluegreen.conf"
finalize_id="$(date -u +%Y%m%dT%H%M%SZ)"
backup_root="/var/backups/mia-direct/$finalize_id"

[[ -f "$mia_env" && -f "$nginx_config" && -f "$bluegreen_config" ]] || {
  echo "APIMaster runtime configuration is incomplete." >&2
  exit 1
}
curl -fsS https://mia.apimaster.ai/health >/dev/null

active_port="$(sed -n '/upstream newapi_backend/,/}/ s/.*127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' "$bluegreen_config")"
case "$active_port" in
  3002) active_service="new-api-blue"; active_container="apimaster-new-api-blue" ;;
  3003) active_service="new-api-green"; active_container="apimaster-new-api-green" ;;
  *) echo "Could not identify the active NewAPI color." >&2; exit 1 ;;
esac

install -d -m 700 "$backup_root"
cp -a "$mia_env" "$backup_root/apimaster.env.mia"
cp -a "$nginx_config" "$backup_root/apimaster.nginx"
printf '%s\n' "$active_service" > "$backup_root/active-service"

temporary_env="$(mktemp)"
awk -F= '$1 != "MIA_TELEGRAM_WEBHOOK_URL" { print }' "$mia_env" > "$temporary_env"
cat "$temporary_env" > "$mia_env"
rm -f "$temporary_env"

temporary_nginx="$(mktemp)"
awk '
  /^    location = \/mia \{/ {
    print "    location = /mia {"
    print "        return 308 https://mia.apimaster.ai/mia/;"
    print "    }"
    replacing = 1
    depth = 1
    next
  }
  /^    location \^~ \/mia\/ \{/ {
    print "    location ^~ /mia/ {"
    print "        return 308 https://mia.apimaster.ai$request_uri;"
    print "    }"
    replacing = 1
    depth = 1
    next
  }
  replacing {
    opens = gsub(/\{/, "{")
    closes = gsub(/\}/, "}")
    depth += opens - closes
    if (depth == 0) replacing = 0
    next
  }
  { print }
' "$nginx_config" > "$temporary_nginx"
cat "$temporary_nginx" > "$nginx_config"
rm -f "$temporary_nginx"

[[ "$(grep -cF 'return 308 https://mia.apimaster.ai' "$nginx_config")" -eq 2 ]] || {
  cp -a "$backup_root/apimaster.env.mia" "$mia_env"
  cp -a "$backup_root/apimaster.nginx" "$nginx_config"
  echo "Failed to install both Mia redirects." >&2
  exit 1
}
grep -qF 'location = /mia/debug {' "$nginx_config" || {
  cp -a "$backup_root/apimaster.env.mia" "$mia_env"
  cp -a "$backup_root/apimaster.nginx" "$nginx_config"
  echo "The protected /mia/debug route was lost." >&2
  exit 1
}
nginx -t || {
  cp -a "$backup_root/apimaster.env.mia" "$mia_env"
  cp -a "$backup_root/apimaster.nginx" "$nginx_config"
  exit 1
}

cd "$newapi_root"
docker compose up -d --no-build --pull never --force-recreate new-api-worker "$active_service"
nginx -s reload
for container in apimaster-new-api-worker "$active_container"; do
  if docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' |
    grep -q '^MIA_TELEGRAM_WEBHOOK_URL='; then
    echo "$container still contains MIA_TELEGRAM_WEBHOOK_URL." >&2
    exit 1
  fi
done

echo "APIMaster Mia entry finalized; finalize_id=$finalize_id active=$active_service"
