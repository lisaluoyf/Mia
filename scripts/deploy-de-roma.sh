#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deploy_host="${MIA_DE_ROMA_HOST:-root@116.203.216.59}"
ssh_jump="${MIA_DE_ROMA_SSH_JUMP:-roma-prod}"

cd "$repository_root"

if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "Mia deployment requires a clean Git worktree." >&2
  exit 1
fi

branch="$(git branch --show-current)"
if [[ "$branch" != "main" ]]; then
  echo "Mia de-roma deployments must run from main, not $branch." >&2
  exit 1
fi

git_sha="$(git rev-parse HEAD)"
git push origin HEAD:main
remote_sha="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
if [[ "$remote_sha" != "$git_sha" ]]; then
  echo "GitHub main does not match local HEAD after push." >&2
  exit 1
fi

started_at="$SECONDS"
ssh -J "$ssh_jump" "$deploy_host" \
  "MIA_RUNTIME_USER=roma MIA_HEALTH_URL=http://172.20.0.1:3010/health MIA_ACTIVATE_RELEASE=false bash -s -- '$git_sha'" \
  < "$repository_root/scripts/server-deploy.sh"
echo "Mia de-roma staging finished in $((SECONDS - started_at))s at $git_sha. The release is not running."
