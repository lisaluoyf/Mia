# Mia

Mia is a Telegram AI assistant that uses an already-bound APIMaster account and
one of that user's existing API Keys. Mia supports chat, image generation and
editing, image understanding, and confirmed asynchronous video generation.

## Behavior

- Private chats: text, images, image documents, and albums enter one intent pipeline.
- Groups: Mia responds to `/image`, `/vision`, `/video`, mentions, direct replies,
  and explicit Mia calls made while replying to media. Results stay in the same Topic.
- `/image`, `/vision`, and `/video` bypass the classifier. Natural-language media
requests use `gpt-5.4` with the triggering user's APIMaster Key. For chat and
vision answers that call returns the final text; only media actions continue to
the selected image or video model.
- Videos always require a 10-minute confirmation draft before the paid request.
- Image and video generation share a three-job per-user concurrency limit.
- APIMaster owns accounts, Keys, quota checks, and model routing.
- Mia never persists or sends a user's API Key to Telegram.

## Conversation context

- Model requests receive Mia's system rules, current conversation metadata,
  private-user long-term memory, the rolling conversation summary, and the
  unsummarized messages in chronological order.
- Images are sent with their pixels, source turn, stable reference, and one of
  `current`, `replied`, `active`, or `historical` so an older image is not
  mistaken for the current image.
- After every ten successful private text-chat turns, Mia replies first and
  then asynchronously asks `MIA_CONTEXT_MODEL` to return the complete refreshed
  memory list and rolling summary. The SQLite replacement is transactional.
- All model-facing instruction text lives in `src/prompts.ts` for review.

## Local development

Requirements: Node.js 20+ and pnpm.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

The APIMaster `new-api` process must have the same `MIA_INTERNAL_SERVICE_KEY`
and expose the Telegram Key resolver and Mia model catalog. `MIA_ROUTER_MODEL`
defaults to `gpt-5.4`; Mia resolves the triggering user's Key for that model, so
there is no platform-owned routing credential. `MIA_CONTEXT_MODEL` independently
defaults to `gpt-5.4` for the ten-turn background compaction. Mia exposes `GET /health`
and the authenticated `POST /telegram/update` receiver on `127.0.0.1:3010` by
default.

## Production deployment

Mia production releases must be committed and pushed to GitHub before the
server fetches and builds the exact commit. From a clean `main` branch, run:

```bash
pnpm deploy:production
```

The deployment reuses a lockfile-keyed dependency cache, performs an atomic
PM2 switch with health-check rollback, and keeps exactly three runnable server
releases. Local `dist/` uploads are reserved for explicitly requested emergency
deployments.

Mia does not own Telegram's public webhook. APIMaster's existing `new-api`
webhook keeps handling account-verification commands and forwards all other
updates to Mia over the authenticated internal receiver.
