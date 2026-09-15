# Mia Web Sandbox PoC

One natural-language edit runs as two short-lived containers:

- `gateway` holds the real APIMaster key and permits only `POST /v1/responses`, one model, a deadline, and a request limit.
- `runner` runs Codex without public network access, with a read-only root filesystem and one writable project directory.

Each project lives at `<projects-root>/<user-id>/<project-id>`. Every edit starts a new Codex process; project files persist as the next edit's context. An atomic lock serializes edits to the same project.

## Server setup

Use a dedicated low-quota APIMaster token for the first PoC. A later Mia integration should write the user's resolved key to a root-only temporary file and pass that file through `MIA_APIMASTER_API_KEY_FILE`; the runner never receives the real key.

CI publishes the credential-free sandbox image for anonymous pull. Production pins the immutable digest and never builds the image locally.

```bash
sudo install -d -m 700 /etc/mia-sandbox /srv/mia-sandbox/projects /srv/mia-sandbox/jobs
printf '%s' 'sk-REPLACE_WITH_POC_TOKEN' | sudo tee /etc/mia-sandbox/apimaster_api_key >/dev/null
sudo chmod 600 /etc/mia-sandbox/apimaster_api_key
sudo install -m 755 run-job.sh /usr/local/bin/mia-sandbox-run
export MIA_SANDBOX_IMAGE='ghcr.io/lisaluoyf/mia-web-sandbox@sha256:REPLACE_ME'
```

Run an initial creation and a follow-up edit against the same project:

```bash
printf '%s\n' '生成一个手机浏览器可玩的猜数字小游戏' >/tmp/mia-prompt.txt
sudo --preserve-env=MIA_SANDBOX_IMAGE mia-sandbox-run liz number-guess /tmp/mia-prompt.txt

printf '%s\n' '加上计分、最佳成绩和重新开始按钮' >/tmp/mia-prompt.txt
sudo --preserve-env=MIA_SANDBOX_IMAGE mia-sandbox-run liz number-guess /tmp/mia-prompt.txt
```

Generated files remain under `/srv/mia-sandbox/projects/liz/number-guess`. This PoC does not publish them publicly yet.

## Security boundary

- The runner has no Docker socket, Linux capabilities, host network, public egress, or writable host paths other than its assigned project and job output.
- The runner sees only a random per-job token. Codex child shells exclude that token from their environment.
- The trusted gateway alone reads the APIMaster key and has external network access.
- The gateway is destroyed after the task; its token is bounded by time, model, and request count.
- Docker is the outer sandbox because the de-roma host has no `/dev/kvm`. This is a PoC boundary, not a production multi-tenant isolation claim.
