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
runtime_link="${MIA_RUNTIME_LINK:-/opt/mia}"
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

pm2_pid() {
  sudo -u "$runtime_user" -H bash -lc "pm2 pid mia" 2>/dev/null | tail -n 1
}

running_release() {
  local pid
  pid="$(pm2_pid)"
  [[ "$pid" =~ ^[0-9]+$ ]] && [[ "$pid" -gt 0 ]] && readlink -f "/proc/$pid/cwd"
}

current_release="$(readlink -f "$current_link" 2>/dev/null || true)"
active_release="$(running_release || true)"
if [[ -f "$current_release/release.json" ]] &&
   grep -q "\"git_sha\": \"$git_sha\"" "$current_release/release.json" &&
   [[ "$active_release" == "$current_release" ]]; then
  echo "Mia $git_sha is already deployed."
  exit 0
fi

previous_release="$active_release"
case "$previous_release" in
  "$releases"/*) ;;
  *) previous_release="$current_release" ;;
esac

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
ln -sfn "$release" "$runtime_link.next"
mv -Tf "$runtime_link.next" "$runtime_link"

activate_release() {
  local target="$1"
  sudo -u "$runtime_user" -H bash -lc \
    "pm2 delete mia >/dev/null 2>&1 || true; cd '$target' && pm2 start '$target/ecosystem.config.cjs' --update-env"
}

save_process_list() {
  sudo -u "$runtime_user" -H bash -lc "pm2 save"
}

rollback() {
  echo "Mia activation check failed; rolling back to $previous_release." >&2
  if [[ -n "$previous_release" && -d "$previous_release" ]]; then
    ln -sfn "releases/$(basename "$previous_release")" "$deploy_root/current.rollback"
    mv -Tf "$deploy_root/current.rollback" "$current_link"
    ln -sfn "$previous_release" "$runtime_link.rollback"
    mv -Tf "$runtime_link.rollback" "$runtime_link"
    activate_release "$previous_release"
    save_process_list
  fi
  if [[ -d "$release" ]]; then
    find -P "$release" -depth -delete
  fi
  exit 1
}

activate_release "$release" || rollback

healthy=0
for _attempt in {1..15}; do
  active_release="$(running_release || true)"
  if [[ "$active_release" == "$release" ]] &&
     curl -fsS http://172.17.0.1:3010/health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
[[ "$healthy" -eq 1 ]] || rollback
save_process_list || rollback

# This is deliberately post-activation and never calls rollback: an intermittent provider
# search failure must not replace an otherwise healthy release. Run it only when production
# explicitly configures a smoke account; the default configuration intentionally has none.
agent_loop_smoke="skipped"
if grep -qE '^MIA_AGENT_SMOKE_ENABLED=true$' "$release/.env"; then
  if ! sudo -u "$runtime_user" -H bash -lc "cd '$release' && node --env-file=.env dist/agent/loop-smoke.js"; then
    echo "Mia release=$release_name sha=$git_sha health=ok agent_loop_smoke=failed rollback=$(basename \"$previous_release\")" >&2
    exit 2
  fi
  agent_loop_smoke="passed"
fi

declare -A keep=(["$release"]=1)
if [[ -n "$previous_release" && -d "$previous_release" && "$previous_release" != "$release" ]]; then
  keep["$previous_release"]=1
fi
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

echo "Mia release=$release_name sha=$git_sha health=ok agent_loop_smoke=$agent_loop_smoke process_cwd=$active_release duration=$((SECONDS - started_at))s rollback=$(basename "$previous_release")"
