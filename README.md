# Mia

Mia is a Telegram AI assistant. Unbound users and bound users without a usable
API Token can use text chat through a dedicated service credential; bound users
continue using their own APIMaster Keys and selected models. Image generation,
editing, understanding, and video generation always require the user's own Key.

## Agent Runtime (Opt-In)

The new single-agent runtime is implemented but disabled by default. Enable only
for explicitly selected Telegram test users:

```dotenv
MIA_AGENT_ENABLED=true
MIA_AGENT_ALLOWED_USERS=123456789
MIA_AGENT_WEB_SEARCH=false
```

Both the enable flag and allowlist are required. The selected chat model must
support native Responses function calls and stateless continuation. No model
defaults are changed and no automatic Chat Completions fallback is used by the
new runtime. Test the actual APIMaster route before enabling it; HTTP 200 alone
does not establish tool compatibility.

- A persisted goal drives tool calls, observations, requirement checks and
  delivery. Plain progress text and queued media IDs are not completion.
- Tools wrap conversation reading, vision, image generation/editing, stickers,
  video and cancellation of unsubmitted media. Optional `search_web` uses the
  existing hosted-search client and rejects answers with zero observed searches.
- Incoming additions are persisted and interrupt stale model output. One active
  goal per user/chat/topic can answer incidental questions while media waits;
  it does not yet maintain multiple independently selectable concurrent goals.
- Videos and additional potentially paid generations require revision-bound,
  ten-minute confirmation. Definite pre-submission validation failures can be
  repaired without authorizing a second paid generation. Media always uses the
  requesting user's credential and existing group/concurrency restrictions.
- Async media execution and Telegram delivery are separate. Completed artifacts
  are stored locally; delivery failures do not regenerate them. Ambiguous remote
  submissions and Telegram sends are retained as unknown, never blindly repeated.
- The webhook durably queues enrolled users' updates before acknowledging them.
  Run checkpoints and native tool results survive restart. Completed/cancelled
  run data and consumed inbox entries have a seven-day cleanup window; unfinished
  checkpoints remain until resolved. Media retains its existing expiry policy.
- Runtime limits: eight model steps per continuation, two additional transient
  model retries, three identical unsuccessful actions, 120 KB history guard,
  24 KB conversation projection, eight active scope workers. This version pauses
  at the context limit; within-run automatic compaction and monetary budgets are
  not implemented. Vision/search calls also incur normal model charges.
- Shutdown stops ingress, aborts model calls and drains executing work before
  closing stores. Only one Mia process may own this SQLite agent scheduler.

The system prompt and tool contract live in `src/agent/`; logs record run IDs,
revisions, steps and tool outcomes without credentials or private reasoning.
Tests use mocked providers/Telegram and real temporary SQLite/media storage;
production channel compatibility and paid end-to-end generation are not verified
by those tests. No production deployment is implied.

Agent answers now reuse the existing structured Mia response schema and Telegram
rich renderer. Definite formatting rejections fall back to HTML, then plain text;
transport failures remain indeterminate and do not trigger duplicate fallback
sends. Each chunk and fallback attempt has a durable delivery identity. Old
plain-text checkpoints and their delivered receipts remain compatible.

Roll back new enrollment by clearing the allowlist or disabling the flag; the
runtime remains loaded to reconcile existing tasks, and existing approval/cancel
buttons still work. New ordinary messages from disabled users follow the legacy
path, so drain active tasks before removing their enrollment. Do not downgrade
the binary while agent jobs remain active: older workers do not understand the
agent-owned delivery boundary.

## Legacy Behavior

- Private chats: text, images, image documents, and albums enter one intent pipeline.
- Groups: Mia responds to `/image`, `/vision`, `/video`, mentions, direct replies,
  and explicit Mia calls made while replying to media. Results stay in the same Topic.
- `/image`, `/vision`, and `/video` bypass the classifier. Natural-language requests
use `gpt-5.4`; only `telegram_not_bound` and `no_usable_api_key` fall back to the
guest text credential. Guest media intents stop at an account activation prompt.
- Telegram's slash menu exposes `/image`, `/video`, `/sticker`, `/new`, and
  `/summary`; `/sticker` is a deterministic private-chat shortcut.
- Videos always require a 10-minute confirmation draft before the paid request.
- Image and video generation share a three-job per-user concurrency limit.
- APIMaster owns accounts, Keys, quota checks, and model routing.
- Mia never persists or sends a user's API Key to Telegram.
- Direct identity and capability questions use a reviewed, server-owned product
  profile instead of model-generated claims. The same capability allowlist is
  included in Mia's system rules for indirect or unsupported phrasing. The
  introduction is delivered as a branded image with a concise caption and
  entry buttons for image generation, video generation, sticker creation, and
  Mini App model settings.

## Conversation context

- Model requests receive Mia's system rules, current conversation metadata,
  private-user long-term memory, the rolling conversation summary, and the
  unsummarized messages in chronological order.
- For users with their own compatible Key, images are sent with pixels, source
  turn, stable reference, and one of `current`, `replied`, `active`, or
  `historical`. Guest text requests receive media metadata but never pixels.
- After every ten successful private text-chat turns, Mia replies first and
  then asynchronously asks `MIA_CONTEXT_MODEL` to return the complete refreshed
  memory list and rolling summary. The SQLite replacement is transactional.
- Legacy model-facing instruction text lives in `src/prompts.ts`; the opt-in
  agent's execution instructions and native tool descriptions live in `src/agent/`.

## Local development

Requirements: Node.js 20+ and pnpm.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

The APIMaster `new-api` process must have the same `MIA_INTERNAL_SERVICE_KEY`
and expose the Telegram Key resolver and Mia model catalog. `MIA_GUEST_CHAT_API_KEY`
must be a deployment-only APIMaster Token restricted to `gpt-5.4`; it is never
used for vision, images, or video. `MIA_ROUTER_MODEL` and `MIA_CONTEXT_MODEL`
default to `gpt-5.4`. Mia exposes `GET /health`
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
