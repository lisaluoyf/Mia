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
  const verifySearch = process.argv[4] === "--web-search";
  if (!Number.isSafeInteger(userId) || userId <= 0 || !model || (process.argv[4] && !verifySearch)) {
    throw new Error("Usage: node --env-file=.env dist/agent/schema-smoke.js TELEGRAM_USER_ID MODEL [--web-search]");
  }
  const config = loadConfig();
  if (!config.agentEnabled) throw new Error("Agent Loop is disabled");
  const client = new APIMasterClient({
    baseUrl: config.apimasterBaseUrl, internalBaseUrl: config.apimasterInternalBaseUrl,
    identityBaseUrl: config.apimasterIdentityBaseUrl, serviceKey: config.miaInternalServiceKey,
    timeoutMs: 60_000,
  });
  if (verifySearch && !config.agentWebSearch) throw new Error("Hosted Web Search is disabled");
  const apiKey = await client.resolveAPIKey(userId, model);
  const unavailable = new Proxy({}, { get() { throw new Error("Smoke test must never execute tools"); } });
  const tools = createAgentTools({ client: unavailable, settings: unavailable, media: unavailable, api: unavailable, botToken: "unused" } as Parameters<typeof createAgentTools>[0]);
  const started = Date.now();
  const result = await responseStep({
    baseUrl: config.apimasterBaseUrl, apiKey, model, instructions,
    input: [{ role: "user", content: verifySearch
      ? "This is an operator compatibility check, not a user task. Use hosted web search once for the current official OpenAI news page. Then call only finish: status completed, text Hosted search OK, presentation with title Check and one paragraph Hosted search OK, actions []. Include one satisfied search requirement. Do not call media, inspection or other function tools."
      : "This is a schema compatibility check, not a user task. Call only finish, status completed, text Schema OK, presentation with title Check and one paragraph Schema OK, actions []. Include one satisfied text requirement with no evidence. Do not call search, media, inspection or other tools." }],
    tools: [...tools.map(tool => tool.definition), finishTool], webSearch: config.agentWebSearch,
    signal: new AbortController().signal, timeoutMs: config.agentTimeoutMs,
  });
  if (result.calls.length !== 1 || result.calls[0]?.name !== "finish") throw new Error("Expected only finish");
  if (verifySearch && !result.output.some(item => item.type === "web_search_call")) throw new Error("No hosted web search was observed");
  const args: unknown = JSON.parse(result.calls[0].arguments);
  if (!args || typeof args !== "object" || !("presentation" in args) || !("status" in args) || args.status !== "completed") throw new Error("Invalid finish");
  const presentation = miaResponseSchema.parse(args.presentation);
  const chunks = renderTelegramRich(presentation);
  if (!chunks.length || !presentation.title) throw new Error("Missing rich output");
  console.log(JSON.stringify({ ok: true, model, toolCount: tools.length + 1 + (config.agentWebSearch ? 1 : 0), hostedWebSearch: verifySearch, richChunks: chunks.length, durationMs: Date.now() - started, executedTools: 0, telegramMessages: 0 }));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, code: error instanceof AgentModelError || error instanceof ResolverError ? error.code : "schema_smoke_failed", ...(error instanceof AgentModelError ? { status: error.status } : {}) }));
  process.exitCode = 1;
});
