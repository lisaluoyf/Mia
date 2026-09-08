import { APIMasterClient, ResolverError } from "../clients/apimaster.js";
import { loadConfig } from "../config.js";
import { miaResponseSchema } from "../presentation/schema.js";
import { renderTelegramRich } from "../presentation/telegram-rich.js";
import { AgentModelError, responseStep } from "./model.js";
import { finishTool, instructions } from "./runtime.js";
import { createAgentTools } from "./tools.js";

// Explicit operator-only probe: one model request, no runtime, tool execution or delivery.
async function main(): Promise<void> {
  const userId = Number(process.argv[2]);
  const model = process.argv[3];
  if (!Number.isSafeInteger(userId) || userId <= 0 || !model) {
    throw new Error("Usage: node --env-file=.env dist/agent/schema-smoke.js TELEGRAM_USER_ID MODEL");
  }
  const config = loadConfig();
  if (!config.agentEnabled || !config.agentAllowedUsers.includes(userId)) throw new Error("Agent user is not enabled");
  const client = new APIMasterClient({
    baseUrl: config.apimasterBaseUrl, internalBaseUrl: config.apimasterInternalBaseUrl,
    identityBaseUrl: config.apimasterIdentityBaseUrl, serviceKey: config.miaInternalServiceKey,
    timeoutMs: 60_000,
  });
  const apiKey = await client.resolveAPIKey(userId, model);
  const unavailable = new Proxy({}, { get() { throw new Error("Smoke test must never execute tools"); } });
  const tools = createAgentTools({ client: unavailable, settings: unavailable, media: unavailable, api: unavailable, botToken: "unused", webSearch: config.agentWebSearch } as Parameters<typeof createAgentTools>[0]);
  const started = Date.now();
  const result = await responseStep({
    baseUrl: config.apimasterBaseUrl, apiKey, model, instructions,
    input: [{ role: "user", content: "This is a schema compatibility check, not a user task. Call only finish, status completed, text Schema OK, presentation with title Check and one paragraph Schema OK, actions []. Include one satisfied text requirement with no evidence. Do not call search, media, inspection or other tools." }],
    tools: [...tools.map(tool => tool.definition), finishTool],
    signal: new AbortController().signal, timeoutMs: 60_000,
  });
  if (result.calls.length !== 1 || result.calls[0]?.name !== "finish") throw new Error("Expected only finish");
  const args: unknown = JSON.parse(result.calls[0].arguments);
  if (!args || typeof args !== "object" || !("presentation" in args) || !("status" in args) || args.status !== "completed") throw new Error("Invalid finish");
  const presentation = miaResponseSchema.parse(args.presentation);
  const chunks = renderTelegramRich(presentation);
  if (!chunks.length || !presentation.title) throw new Error("Missing rich output");
  console.log(JSON.stringify({ ok: true, model, toolCount: tools.length + 1, richChunks: chunks.length, durationMs: Date.now() - started, executedTools: 0, telegramMessages: 0 }));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, code: error instanceof AgentModelError || error instanceof ResolverError ? error.code : "schema_smoke_failed", ...(error instanceof AgentModelError ? { status: error.status } : {}) }));
  process.exitCode = 1;
});
