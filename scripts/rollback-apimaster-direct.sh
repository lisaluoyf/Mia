#!/usr/bin/env bash
set -Eeuo pipefail

finalize_id="${1:-}"
[[ "$finalize_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || {
  echo "usage: rollback-apimaster-direct.sh <YYYYMMDDTHHMMSSZ>" >&2
  exit 2
}
[[ "$(id -u)" -eq 0 ]] || { echo "This script must run as root on APIMaster." >&2; exit 1; }

newapi_root="/opt/newapi"
backup_root="/var/backups/mia-direct/$finalize_id"
active_service="$(cat "$backup_root/active-service")"
case "$active_service" in new-api-blue|new-api-green) ;; *) echo "Invalid active service backup." >&2; exit 1 ;; esac

cp -a "$backup_root/apimaster.env.mia" "$newapi_root/.env.mia"
cp -a "$backup_root/apimaster.nginx" /etc/nginx/sites-enabled/apimaster.ai
nginx -t
cd "$newapi_root"
docker compose up -d --no-build --pull never --force-recreate new-api-worker "$active_service"
nginx -s reload
echo "APIMaster Mia entry restored from finalize_id=$finalize_id."
