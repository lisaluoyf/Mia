# Mia

Mia is a Telegram AI assistant that uses an already-bound APIMaster account and
one of that user's existing API Keys. The first release supports stateless text
chat with the fixed `grok-4.5` model.

## Behavior

- Private chats: every text message triggers Mia.
- Groups: Mia responds only when mentioned or directly replied to.
- APIMaster owns accounts, Keys, quota checks, and model routing.
- Mia never persists or sends a user's API Key to Telegram.

## Local development

Requirements: Node.js 20+ and pnpm.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

The APIMaster `new-api` process must have the same `MIA_INTERNAL_SERVICE_KEY`
and expose `POST /api/user/internal/telegram-api-key`. Mia exposes `GET /health`
and the authenticated `POST /telegram/update` receiver on `127.0.0.1:3010` by
default.

## Production with PM2

Provide the environment variables through the server's secret/environment
management, then run:

```bash
pnpm install --frozen-lockfile
pnpm build
pm2 start ecosystem.config.cjs
```

Mia does not own Telegram's public webhook. APIMaster's existing `new-api`
webhook keeps handling account-verification commands and forwards all other
updates to Mia over the authenticated internal receiver.
