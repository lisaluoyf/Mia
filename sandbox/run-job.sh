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
MODEL="${MIA_SANDBOX_MODEL:-gpt-5.4}"
TIMEOUT_SECONDS="${MIA_JOB_TIMEOUT_SECONDS:-600}"
MAX_REQUESTS="${MIA_JOB_MAX_REQUESTS:-24}"
UPSTREAM_BASE_URL="${MIA_APIMASTER_BASE_URL:-https://apimaster.ai/}"

[[ -f "$API_KEY_FILE" && -s "$API_KEY_FILE" ]] || { echo "APIMaster API key file is missing or empty" >&2; exit 1; }
[[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]{0,3}$ ]] || { echo "invalid timeout" >&2; exit 2; }
[[ "$MAX_REQUESTS" =~ ^[1-9][0-9]{0,2}$ ]] || { echo "invalid max requests" >&2; exit 2; }

PROJECT_DIR="$PROJECTS_ROOT/$USER_ID/$PROJECT_ID"
LOCK_DIR="$PROJECTS_ROOT/.locks/${USER_ID}--${PROJECT_ID}"
JOB_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 6)"
JOB_DIR="$JOBS_ROOT/$JOB_ID"
NETWORK="mia-job-${JOB_ID,,}"
GATEWAY_CONTAINER="mia-gateway-${JOB_ID,,}"
RUNNER_CONTAINER="mia-runner-${JOB_ID,,}"
JOB_TOKEN="$(openssl rand -hex 32)"
EXPIRES_AT_MS="$(( ($(date +%s) + TIMEOUT_SECONDS + 30) * 1000 ))"

mkdir -p "$PROJECT_DIR" "$JOBS_ROOT" "$(dirname "$LOCK_DIR")"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "project is already being edited" >&2
  exit 75
fi
mkdir -p "$JOB_DIR"
cp "$PROMPT_FILE" "$JOB_DIR/prompt.txt"
chmod 700 "$PROJECT_DIR" "$JOB_DIR"
chmod 600 "$JOB_DIR/prompt.txt"
chown -R 1000:1000 "$PROJECT_DIR" "$JOB_DIR"

cleanup() {
  docker rm -f "$RUNNER_CONTAINER" "$GATEWAY_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
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
    --memory 1536m \
    --memory-swap 1536m \
    --cpus 2 \
    --pids-limit 256 \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --mount "type=bind,src=$PROJECT_DIR,dst=/workspace" \
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

[[ -s "$PROJECT_DIR/index.html" ]] || { echo "job completed without index.html" >&2; exit 1; }
echo "job=$JOB_ID"
echo "project=$PROJECT_DIR"
echo "result=$JOB_DIR/result.txt"
