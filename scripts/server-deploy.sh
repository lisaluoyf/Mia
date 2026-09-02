#!/usr/bin/env bash
set -Eeuo pipefail

git_sha="${1:-}"
deploy_root="${MIA_DEPLOY_ROOT:-/srv/mia}"
repository_url="${MIA_REPOSITORY_URL:-https://github.com/lisaluoyf/Mia.git}"
runtime_user="${MIA_RUNTIME_USER:-roma}"
keep_releases=3
pnpm_version="10.28.2"

if [[ ! "$git_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: server-deploy.sh <40-character-git-sha>" >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "The Mia server deploy must run as root." >&2
  exit 1
fi

mirror="$deploy_root/repo.git"
releases="$deploy_root/releases"
shared="$deploy_root/shared"
current_link="$deploy_root/current"
started_at="$SECONDS"

mkdir -p "$releases" "$shared/dependencies" "$shared/pnpm-store"
exec 9>"$deploy_root/deploy.lock"
if ! flock -n 9; then
  echo "Another Mia deployment is already running." >&2
  exit 1
fi

if [[ ! -d "$mirror" ]]; then
  git clone --mirror "$repository_url" "$mirror"
else
  git --git-dir="$mirror" remote set-url origin "$repository_url"
  git --git-dir="$mirror" fetch --prune origin '+refs/heads/*:refs/heads/*'
fi

remote_sha="$(git --git-dir="$mirror" rev-parse refs/heads/main)"
if [[ "$remote_sha" != "$git_sha" ]]; then
  echo "Requested SHA is not the current GitHub main commit." >&2
  exit 1
fi

current_release="$(readlink -f "$current_link" 2>/dev/null || true)"
if [[ -f "$current_release/release.json" ]] && grep -q "\"git_sha\": \"$git_sha\"" "$current_release/release.json"; then
  echo "Mia $git_sha is already deployed."
  exit 0
fi

short_sha="${git_sha:0:12}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
release_name="mia-git-$short_sha-$timestamp"
release="$releases/$release_name"
staging="$releases/.$release_name.tmp.$$"

cleanup_staging() {
  if [[ -d "$staging" ]]; then
    find -P "$staging" -depth -delete
  fi
}
trap cleanup_staging EXIT

mkdir -p "$staging"
git --git-dir="$mirror" archive "$git_sha" | tar -x -C "$staging"
ln -s /etc/mia/mia.env "$staging/.env"

lock_hash="$(sha256sum "$staging/pnpm-lock.yaml" | awk '{print $1}')"
dependency_cache="$shared/dependencies/$lock_hash"

if [[ ! -d "$dependency_cache/node_modules" ]]; then
  mkdir -p "$dependency_cache"
  current_lock_hash=""
  if [[ -f "$current_release/pnpm-lock.yaml" ]]; then
    current_lock_hash="$(sha256sum "$current_release/pnpm-lock.yaml" | awk '{print $1}')"
  fi
  if [[ "$current_lock_hash" == "$lock_hash" && -d "$current_release/node_modules" ]]; then
    resolved_modules="$(readlink -f "$current_release/node_modules")"
    cp -al "$resolved_modules" "$dependency_cache/node_modules"
  else
    chown -R "$runtime_user:$runtime_user" "$staging" "$dependency_cache" "$shared/pnpm-store"
    sudo -u "$runtime_user" -H bash -lc \
      "cd '$staging' && CI=true corepack pnpm@$pnpm_version install --frozen-lockfile --prefer-offline --store-dir '$shared/pnpm-store'"
    mv "$staging/node_modules" "$dependency_cache/node_modules"
  fi
  chown -R "$runtime_user:$runtime_user" "$dependency_cache"
fi

chown -R "$runtime_user:$runtime_user" "$staging"
ln -s "$dependency_cache/node_modules" "$staging/node_modules"

sudo -u "$runtime_user" -H bash -lc "
  cd '$staging'
  corepack pnpm@$pnpm_version run build:server & server_pid=\$!
  corepack pnpm@$pnpm_version run build:web & web_pid=\$!
  wait \$server_pid
  wait \$web_pid
"

cat > "$staging/release.json" <<EOF
{
  "service": "mia",
  "git_sha": "$git_sha",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "node": "$(node --version)",
  "pnpm": "$pnpm_version"
}
EOF
chown "$runtime_user:$runtime_user" "$staging/release.json"
mv "$staging" "$release"
trap - EXIT

ln -sfn "releases/$release_name" "$deploy_root/current.next"
mv -Tf "$deploy_root/current.next" "$current_link"

rollback() {
  echo "Mia health check failed; rolling back to $current_release." >&2
  if [[ -n "$current_release" && -d "$current_release" ]]; then
    ln -sfn "releases/$(basename "$current_release")" "$deploy_root/current.rollback"
    mv -Tf "$deploy_root/current.rollback" "$current_link"
    sudo -u "$runtime_user" -H bash -lc "cd /opt/mia && pm2 startOrReload ecosystem.config.cjs --update-env && pm2 save"
  fi
  if [[ -d "$release" ]]; then
    find -P "$release" -depth -delete
  fi
  exit 1
}

sudo -u "$runtime_user" -H bash -lc \
  "cd /opt/mia && pm2 startOrReload ecosystem.config.cjs --update-env && pm2 save" || rollback

healthy=0
for _attempt in {1..15}; do
  if curl -fsS http://172.17.0.1:3010/health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
[[ "$healthy" -eq 1 ]] || rollback

declare -A keep=(["$release"]=1)
while IFS= read -r candidate && [[ "${#keep[@]}" -lt "$keep_releases" ]]; do
  [[ "$candidate" == "$release" ]] && continue
  keep["$candidate"]=1
done < <(find "$releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)

while IFS= read -r candidate; do
  [[ -n "${keep[$candidate]:-}" ]] && continue
  case "$candidate" in
    "$releases"/*) find -P "$candidate" -depth -delete ;;
    *) echo "Refusing to remove unexpected release path: $candidate" >&2; exit 1 ;;
  esac
done < <(find "$releases" -mindepth 1 -maxdepth 1 -type d -print)

echo "Mia release=$release_name sha=$git_sha health=ok duration=$((SECONDS - started_at))s rollback=$(basename "$current_release")"
