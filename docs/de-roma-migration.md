# Mia de-roma migration

Target: `116.203.216.59` (`ubuntu-16gb-nbg1-1`). Mia runs there as a PM2 process bound to the Docker bridge address `172.20.0.1:3010`; the existing `hub-caddy` is the only public ingress. APIMaster remains responsible for accounts, user API Keys, quota, billing, model routing, and the public Telegram webhook.

## Traffic after migration

```text
Telegram -> APIMaster webhook -> https://de-api.romaapi.com/mia-internal/telegram/update
apimaster.ai/mia/* -> APIMaster nginx -> https://de-api.romaapi.com/mia/*
Mia -> https://apimaster.ai -> account, key, quota, model and media APIs
Mia -> Docker sandbox -> per-project Codex job
```

The intermediate forwarding step preserves APIMaster's existing Telegram account-verification behavior. Moving the public Telegram webhook itself belongs in a later migration.

## Release and cutover

Production changes must be committed and pushed to GitHub first.

```bash
ssh -J roma-prod root@116.203.216.59 'bash -s' < scripts/bootstrap-de-roma.sh
pnpm deploy:de-roma
ssh -J roma-prod root@116.203.216.59 '/srv/mia/current/scripts/install-de-roma-route.sh'
CONFIRM_MIA_CUTOVER=YES bash scripts/cutover-de-roma.sh
```

`deploy:de-roma` builds the exact GitHub `main` commit but intentionally does not start Mia. The cutover copies `/etc/mia/mia.env`, replaces only location-dependent URLs, stops the old Mia process, transfers all of `/var/lib/mia` while SQLite is closed, starts the target process, checks both local and Caddy health, then updates APIMaster's webhook and `/mia` proxies.

On any error after the old process stops, the cutover attempts to restore APIMaster's backed-up env/Nginx files, stop the target Mia, and restart the source Mia. Backups are timestamped with the printed `cutover_id`.

## Sandbox

The Codex image is built by `.github/workflows/web-sandbox.yml`; the production server only pulls the immutable image. Install the runner after staging:

```bash
ssh -J roma-prod root@116.203.216.59 \
  'install -m 755 /srv/mia/current/sandbox/run-job.sh /usr/local/bin/mia-sandbox-run'
```

The initial PoC uses an operator-provided low-quota token. Mia integration should resolve the requesting user's APIMaster key into a root-only temporary file for the trusted gateway container and delete it after the job. The untrusted Codex container receives only a random job token and has no public network.
