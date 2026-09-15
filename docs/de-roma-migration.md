# Mia direct entry on de-roma

Target: `116.203.216.59`. Mia runs as the `roma` user, listens on
`172.20.0.1:3010`, and is published by the existing `hub-caddy` container.
APIMaster remains responsible for accounts, Telegram identity binding, user API
Keys, quota, billing, and the model catalog.

## Production traffic

```text
Telegram -------> mia.apimaster.ai -------> de-roma Mia
Mia Mini App ---> mia.apimaster.ai -------> de-roma Mia
de-roma Mia ----- HTTPS API --------------> APIMaster
```

`https://apimaster.ai/mia/` permanently redirects to the new public host.
`/mia/debug` is the only exception: APIMaster keeps its login/allowlist check and
proxies the authorized request to Mia. The public Mia host returns `404` for
`/mia/debug`, `/internal/debug/*`, and the legacy `/telegram/update` receiver.

The old authenticated route at
`https://de-api.romaapi.com/mia-internal/telegram/update` remains installed for
one release cycle so Telegram can be rolled back to APIMaster without changing
Mia code.

## Release order

All production code must be committed and pushed before deployment.

1. Deploy NewAPI `main` with
   `POST /api/user/internal/mia-telegram-verification`.
2. Add a DNS-only A record: `mia.apimaster.ai -> 116.203.216.59`.
3. From clean, pushed Mia `main`, copy the existing Telegram webhook secret and
   set `MIA_PUBLIC_BASE_URL=https://mia.apimaster.ai`:

   ```bash
   bash scripts/prepare-direct-entry.sh
   ```

4. Deploy and activate the exact pushed Mia revision:

   ```bash
   MIA_DE_ROMA_ACTIVATE_RELEASE=true pnpm deploy:de-roma
   ```

5. Install the standalone Caddy site and verify public boundaries:

   ```bash
   ssh -J roma-prod root@116.203.216.59 \
     '/srv/mia/current/scripts/install-de-roma-route.sh'
   curl -fsS https://mia.apimaster.ai/health
   curl -I https://mia.apimaster.ai/mia/
   test "$(curl -sS -o /dev/null -w '%{http_code}' https://mia.apimaster.ai/mia/debug)" = 404
   test "$(curl -sS -o /dev/null -w '%{http_code}' https://mia.apimaster.ai/internal/debug/requests)" = 404
   ```

6. Test `/start login_*`, `bind_existing`, and `/start verify_*` with the Lisa
   test account, then switch Telegram without dropping pending updates:

   ```bash
   bash scripts/switch-telegram-direct.sh
   ```

7. On APIMaster, replace ordinary `/mia` proxies with permanent redirects and
   remove `MIA_TELEGRAM_WEBHOOK_URL` from both active NewAPI processes:

   ```bash
   ssh root@188.245.245.213 \
     'CONFIRM_MIA_DIRECT_FINALIZE=YES bash -s' \
     < scripts/finalize-apimaster-direct.sh
   ```

8. Make the obsolete APIMaster workspace secrets unreadable by `roma`:

   ```bash
   ssh -J roma-prod root@116.203.216.59 'bash -s' \
     < scripts/harden-de-roma-secrets.sh
   ```

The Caddy installer validates and reloads Caddy atomically. The APIMaster
finalizer prints a `finalize_id`; its backup contains the previous Nginx config,
Mia forwarding environment, and active NewAPI color.

## Verification

- `getWebhookInfo` reports `https://mia.apimaster.ai/telegram/webhook`, no last
  error, and a non-growing `pending_update_count`.
- Text, group messages, callback buttons, inline queries, image tasks, and video
  tasks arrive directly at Mia.
- `https://apimaster.ai/mia/` returns `308` to the same path on the new host.
- `https://apimaster.ai/mia/debug` retains APIMaster authentication and the Lisa
  allowlist.
- APIMaster NewAPI and worker containers do not contain
  `MIA_TELEGRAM_WEBHOOK_URL` and produce no Mia forwarding logs.
- No Mia process or port `3010` remains on APIMaster.
- Mia writes only to `/var/lib/mia` and sandbox projects remain under
  `/srv/mia-sandbox/projects`.
- `/srv/mia/current/release.json`, the active PM2 process directory, GitHub
  `main`, and `/usr/local/bin/mia-sandbox-run` all come from the pushed release.

## Rollback

Restore Telegram first; pending updates are retained:

```bash
bash scripts/rollback-telegram-to-apimaster.sh
```

Restore APIMaster forwarding and the old `/mia` proxy with the finalizer's ID:

```bash
ssh root@188.245.245.213 'bash -s -- FINALIZE_ID' \
  < scripts/rollback-apimaster-direct.sh
```

Mia process activation is independently health checked by `deploy:de-roma` and
automatically returns to the prior release on failure. DNS may remain in place
during rollback.

## Sandbox

The Codex image is built by `.github/workflows/web-sandbox.yml`; production only
pulls the immutable image. Install the runner from the same pushed release:

```bash
ssh -J roma-prod root@116.203.216.59 \
  'install -m 755 /srv/mia/current/sandbox/run-job.sh /usr/local/bin/mia-sandbox-run'
```

Bot integration for user-created games and the ten-minute sandbox job timeout
are intentionally outside this entry-point migration.
