#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deploy_host="${MIA_DEPLOY_HOST:-root@188.245.245.213}"

cd "$repository_root"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Mia deployment requires a clean Git worktree." >&2
  exit 1
fi

if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "Mia deployment requires all source files to be committed." >&2
  exit 1
fi

branch="$(git branch --show-current)"
if [[ "$branch" != "main" ]]; then
  echo "Mia production deployments must run from main, not $branch." >&2
  exit 1
fi

git_sha="$(git rev-parse HEAD)"
if [[ ! "$git_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Could not resolve the Mia Git SHA." >&2
  exit 1
fi

git push origin HEAD:main
remote_sha="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
if [[ "$remote_sha" != "$git_sha" ]]; then
  echo "GitHub main does not match local HEAD after push." >&2
  exit 1
fi

started_at="$SECONDS"
ssh "$deploy_host" "bash -s -- '$git_sha'" < "$repository_root/scripts/server-deploy.sh"
echo "Mia production deployment finished in $((SECONDS - started_at))s at $git_sha."
