#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <user-id> <project-id> <prompt-file>" >&2
  exit 2
}

[[ $# -eq 3 ]] || usage

USER_ID="$1"
PROJECT_ID="$2"
PROMPT_FILE="$3"

[[ "$USER_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$ ]] || { echo "invalid user id" >&2; exit 2; }
[[ "$PROJECT_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$ ]] || { echo "invalid project id" >&2; exit 2; }
[[ -f "$PROMPT_FILE" && -s "$PROMPT_FILE" ]] || { echo "prompt file is missing or empty" >&2; exit 2; }

IMAGE="${MIA_SANDBOX_IMAGE:?set MIA_SANDBOX_IMAGE to an immutable image reference}"
PROJECTS_ROOT="${MIA_PROJECTS_ROOT:-/srv/mia-sandbox/projects}"
JOBS_ROOT="${MIA_JOBS_ROOT:-/srv/mia-sandbox/jobs}"
API_KEY_FILE="${MIA_APIMASTER_API_KEY_FILE:-/etc/mia-sandbox/apimaster_api_key}"
MODEL="${MIA_SANDBOX_MODEL:-gpt-5.6-sol}"
TIMEOUT_SECONDS="${MIA_JOB_TIMEOUT_SECONDS:-600}"
MAX_REQUESTS="${MIA_JOB_MAX_REQUESTS:-24}"
RUNNER_MEMORY_MB="${MIA_JOB_MEMORY_MB:-3072}"
UPSTREAM_BASE_URL="${MIA_APIMASTER_BASE_URL:-https://apimaster.ai/}"

[[ -f "$API_KEY_FILE" && -s "$API_KEY_FILE" ]] || { echo "APIMaster API key file is missing or empty" >&2; exit 1; }
[[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]{0,3}$ ]] || { echo "invalid timeout" >&2; exit 2; }
[[ "$MAX_REQUESTS" =~ ^[1-9][0-9]{0,2}$ ]] || { echo "invalid max requests" >&2; exit 2; }
[[ "$RUNNER_MEMORY_MB" =~ ^[1-9][0-9]{2,4}$ ]] && (( RUNNER_MEMORY_MB >= 512 && RUNNER_MEMORY_MB <= 8192 )) || { echo "invalid runner memory" >&2; exit 2; }

PROJECT_DIR="$PROJECTS_ROOT/$USER_ID/$PROJECT_ID"
LOCK_DIR="$PROJECTS_ROOT/.locks/${USER_ID}--${PROJECT_ID}"
JOB_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 6)"
JOB_DIR="$JOBS_ROOT/$JOB_ID"
STAGING_ROOT="$PROJECTS_ROOT/.staging"
WORKSPACE_DIR="$STAGING_ROOT/$JOB_ID"
BACKUP_DIR="$STAGING_ROOT/$JOB_ID.backup"
NETWORK="mia-job-${JOB_ID,,}"
GATEWAY_CONTAINER="mia-gateway-${JOB_ID,,}"
RUNNER_CONTAINER="mia-runner-${JOB_ID,,}"
JOB_TOKEN="$(openssl rand -hex 32)"
EXPIRES_AT_MS="$(( ($(date +%s) + TIMEOUT_SECONDS + 30) * 1000 ))"

mkdir -p "$PROJECTS_ROOT/$USER_ID" "$JOBS_ROOT" "$STAGING_ROOT" "$(dirname "$LOCK_DIR")"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "project is already being edited" >&2
  exit 75
fi
mkdir -p "$JOB_DIR" "$WORKSPACE_DIR"
if [[ -d "$PROJECT_DIR" ]]; then
  cp -a "$PROJECT_DIR/." "$WORKSPACE_DIR/"
elif [[ -e "$PROJECT_DIR" ]]; then
  echo "project path is not a directory" >&2
  exit 1
fi
cp "$PROMPT_FILE" "$JOB_DIR/prompt.txt"
chmod 700 "$JOB_DIR" "$WORKSPACE_DIR"
chmod 600 "$JOB_DIR/prompt.txt"
chown -R 1000:1000 "$WORKSPACE_DIR" "$JOB_DIR"

cleanup() {
  docker rm -f "$RUNNER_CONTAINER" "$GATEWAY_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$WORKSPACE_DIR"
  if [[ -d "$BACKUP_DIR" && -d "$PROJECT_DIR" ]]; then
    rm -rf "$BACKUP_DIR"
  fi
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker network create --internal "$NETWORK" >/dev/null

docker run -d --rm \
  --name "$GATEWAY_CONTAINER" \
  --network bridge \
  --user 0:0 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --memory 256m \
  --cpus 0.5 \
  --pids-limit 96 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --mount "type=bind,src=$API_KEY_FILE,dst=/run/secrets/apimaster_api_key,readonly" \
  -e "JOB_TOKEN=$JOB_TOKEN" \
  -e "JOB_EXPIRES_AT_MS=$EXPIRES_AT_MS" \
  -e "MAX_REQUESTS=$MAX_REQUESTS" \
  -e "ALLOWED_MODEL=$MODEL" \
  -e "APIMASTER_BASE_URL=$UPSTREAM_BASE_URL" \
  "$IMAGE" gateway.js >/dev/null

docker network connect --alias gateway "$NETWORK" "$GATEWAY_CONTAINER"

for _ in $(seq 1 20); do
  if docker exec "$GATEWAY_CONTAINER" node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    break
  fi
  sleep 0.25
done
docker exec "$GATEWAY_CONTAINER" node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

set +e
timeout --signal=TERM --kill-after=15s "$TIMEOUT_SECONDS" \
  docker run --rm \
    --name "$RUNNER_CONTAINER" \
    --network "$NETWORK" \
    --read-only \
    --tmpfs /tmp:rw,nosuid,size=512m \
    --tmpfs /home/node:rw,nosuid,size=64m \
    --memory "${RUNNER_MEMORY_MB}m" \
    --memory-swap "${RUNNER_MEMORY_MB}m" \
    --cpus 2 \
    --pids-limit 256 \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --mount "type=bind,src=$WORKSPACE_DIR,dst=/workspace" \
    --mount "type=bind,src=$JOB_DIR,dst=/run/job" \
    -e "JOB_TOKEN=$JOB_TOKEN" \
    -e "ALLOWED_MODEL=$MODEL" \
    "$IMAGE" run-codex.js \
    >"$JOB_DIR/codex.log" 2>&1
EXIT_CODE=$?
set -e

printf '%s\n' "$EXIT_CODE" >"$JOB_DIR/exit-code"
if [[ $EXIT_CODE -ne 0 ]]; then
  echo "sandbox job failed (job=$JOB_ID, exit=$EXIT_CODE)" >&2
  tail -n 80 "$JOB_DIR/codex.log" >&2
  exit "$EXIT_CODE"
fi

[[ -s "$WORKSPACE_DIR/index.html" ]] || { echo "job completed without index.html" >&2; exit 1; }
if find "$WORKSPACE_DIR" -type l -print -quit | grep -q .; then
  echo "project contains unsupported symbolic links" >&2
  exit 1
fi

if [[ -d "$PROJECT_DIR" ]]; then
  mv "$PROJECT_DIR" "$BACKUP_DIR"
fi
if ! mv "$WORKSPACE_DIR" "$PROJECT_DIR"; then
  if [[ -d "$BACKUP_DIR" ]]; then
    mv "$BACKUP_DIR" "$PROJECT_DIR"
  fi
  echo "failed to publish project workspace" >&2
  exit 1
fi
rm -rf "$BACKUP_DIR"

echo "job=$JOB_ID"
echo "project=$PROJECT_DIR"
echo "result=$JOB_DIR/result.txt"
