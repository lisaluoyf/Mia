#!/usr/bin/env bash
set -Eeuo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "This script must run as root on de-roma." >&2; exit 1; }

files=(
  /home/roma/apimaster-machuang/apimaster-ai/.env.production
  /home/roma/apimaster-machuang/apimaster-ai/.env.local
)

for file in "${files[@]}"; do
  [[ -f "$file" && ! -L "$file" ]] || { echo "Secret file is missing or unsafe: $file" >&2; exit 1; }
  chown root:root "$file"
  chmod 600 "$file"
  if sudo -u roma test -r "$file"; then
    echo "roma can still read $file." >&2
    exit 1
  fi
done

echo "APIMaster workspace secret files are root-only on de-roma."
