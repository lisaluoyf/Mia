#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "install-de-roma-route.sh must run as root on de-roma." >&2
  exit 1
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
caddyfile="${MIA_DE_ROMA_CADDYFILE:-/root/romaapi.com/caddy/Caddyfile.hub}"
container="${MIA_DE_ROMA_CADDY_CONTAINER:-hub-caddy}"
snippet="$repository_root/deploy/caddy/mia-de-roma.handle"
public_site="$repository_root/deploy/caddy/mia-public-site.caddy"

[[ -f "$caddyfile" ]] || { echo "Caddyfile not found: $caddyfile" >&2; exit 1; }
[[ -f "$snippet" ]] || { echo "Mia route snippet not found: $snippet" >&2; exit 1; }
[[ -f "$public_site" ]] || { echo "Mia public site snippet not found: $public_site" >&2; exit 1; }
docker inspect "$container" >/dev/null 2>&1 || { echo "Caddy container not found: $container" >&2; exit 1; }

if grep -q 'BEGIN MIA PUBLIC SITE' "$caddyfile"; then
  echo "Mia public Caddy site is already installed."
  exit 0
fi

backup="$caddyfile.bak-mia-$(date -u +%Y%m%dT%H%M%SZ)"
temporary="$(mktemp "${caddyfile}.tmp.XXXXXX")"
cp -a "$caddyfile" "$backup"

cp "$caddyfile" "$temporary"
if ! grep -q 'BEGIN MIA DE-ROMA ROUTES' "$temporary"; then
  legacy_temporary="$(mktemp "${caddyfile}.legacy.XXXXXX")"
  awk -v snippet="$snippet" '
    { print }
    /^de-api\.romaapi\.com \{$/ {
      while ((getline line < snippet) > 0) print line
      close(snippet)
      inserted = 1
    }
    END { if (!inserted) exit 42 }
  ' "$temporary" > "$legacy_temporary" || {
    rm -f "$temporary" "$legacy_temporary"
    echo "Could not locate the de-api.romaapi.com site block." >&2
    exit 1
  }
  mv "$legacy_temporary" "$temporary"
fi
printf '\n' >> "$temporary"
cat "$public_site" >> "$temporary"

cat "$temporary" > "$caddyfile"
rm -f "$temporary"
if ! docker exec "$container" caddy validate --config /etc/caddy/Caddyfile; then
  cp -a "$backup" "$caddyfile"
  echo "Caddy validation failed; restored $backup" >&2
  exit 1
fi
if ! docker exec "$container" caddy reload --config /etc/caddy/Caddyfile; then
  cp -a "$backup" "$caddyfile"
  docker exec "$container" caddy reload --config /etc/caddy/Caddyfile || true
  echo "Caddy reload failed; restored $backup" >&2
  exit 1
fi

echo "Mia public Caddy site installed; legacy rollback route retained; backup=$backup"
