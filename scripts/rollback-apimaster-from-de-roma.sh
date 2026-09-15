#!/usr/bin/env bash
set -Eeuo pipefail

cutover_id="${1:-}"
[[ "$cutover_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || {
  echo "usage: rollback-apimaster-from-de-roma.sh <YYYYMMDDTHHMMSSZ>" >&2
  exit 2
}
[[ "$(id -u)" -eq 0 ]] || { echo "This script must run as root on APIMaster." >&2; exit 1; }

newapi_root="/opt/newapi"
mia_env="$newapi_root/.env.mia"
nginx_config="/etc/nginx/sites-enabled/apimaster.ai"
backup_root="/var/backups/mia-cutover/$cutover_id"
env_backup="$backup_root/apimaster.env.mia"
nginx_backup="$backup_root/apimaster.nginx"

[[ -f "$env_backup" && -f "$nginx_backup" ]] || {
  echo "Rollback files for $cutover_id are missing." >&2
  exit 1
}

cp -a "$env_backup" "$mia_env"
cp -a "$nginx_backup" "$nginx_config"
nginx -t
cd "$newapi_root"
docker compose up -d --no-build --pull never --force-recreate new-api-worker new-api-green
nginx -s reload
echo "APIMaster Mia routing rolled back; cutover_id=$cutover_id"
