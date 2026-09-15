#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "bootstrap-de-roma.sh must run as root on the target server." >&2
  exit 1
fi

if ! id roma >/dev/null 2>&1; then
  echo "The target server must already have the roma runtime user." >&2
  exit 1
fi

for command in node npm corepack docker git curl flock; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

if ! command -v pm2 >/dev/null; then
  npm install --global pm2@6.0.13
fi

install -d -m 755 -o root -g root /srv/mia
install -d -m 750 -o root -g roma /etc/mia
install -d -m 700 -o root -g root /etc/mia-sandbox
install -d -m 700 -o roma -g roma /var/lib/mia
install -d -m 700 -o root -g root /srv/mia-sandbox /srv/mia-sandbox/projects /srv/mia-sandbox/jobs

if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  if ! ufw status | grep -qE '3010/tcp\s+ALLOW IN\s+172\.20\.0\.0/16'; then
    ufw allow from 172.20.0.0/16 to any port 3010 proto tcp comment 'Mia from hub-caddy only'
  fi
fi

echo "de-roma bootstrap complete"
