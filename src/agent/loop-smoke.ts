import type { Logger } from "pino";
import { APIMasterClient } from "../clients/apimaster.js";
import { AgentModelError, responseStep } from "./model.js";
import { AgentRuntime, instructions } from "./runtime.js";
import { AgentStore } from "./store.js";
import { emptySideEffects, reportSummary, type AgentTestReport, type AgentTestScenarioReport } from "./test-report.js";
import type { AgentInput, Run } from "./types.js";

export interface AgentLoopSmokeOptions {
  client: Pick<APIMasterClient, "resolveAPIKey">;
  baseUrl: string;
  userId: number;
  model: string;
  timeoutMs: number;
  logger?: Pick<Logger, "info" | "warn">;
}

function smokeInput(userId: number, search: boolean): AgentInput {
  return {
    key: `agent-loop-smoke:${search ? "search" : "text"}`,
    userId, chatId: userId, threadId: null, messageId: search ? 2 : 1, replyToMessageId: null,
    language: "en",
    text: search
      ? "This is an internal compatibility check. Use hosted web search once for the current official OpenAI news page, then call only finish with status completed, text Hosted search OK, and one satisfied search requirement. Do not call any media, inspection, or other function tools."
      : "This is an internal compatibility check. Call only finish with status completed, text Text OK, and one satisfied text requirement. Do not call search, media, inspection, or other function tools.",
    media: [], context: "",
  };
}

async function runScenario(options: AgentLoopSmokeOptions, search: boolean): Promise<AgentTestScenarioReport> {
  const scenario = search ? "production_hosted_search" : "production_text";
  const started = Date.now();
  const store = new AgentStore(":memory:");
  const delivered: Run[] = [];
  let modelSteps = 0;
  const runtime = new AgentRuntime({
    store,
    tools: [],
    model: async (_run, input, tools, signal) => {
      modelSteps += 1;
      const apiKey = await options.client.resolveAPIKey(options.userId, options.model);
      return responseStep({
        baseUrl: options.baseUrl,
        apiKey,
        model: options.model,
        instructions,
        input,
        tools,
        webSearch: search,
        signal,
        timeoutMs: options.timeoutMs,
      });
    },
    // Intentionally no Telegram API: this probe only records what delivery would render.
    notify: () => Promise.resolve(null),
    deliver: (run) => { delivered.push(structuredClone(run)); return Promise.resolve(); },
    logger: options.logger ?? { info: () => undefined, warn: () => undefined },
  });
  try {
    runtime.enqueue(smokeInput(options.userId, search));
    await runtime.drain();
    const completed = delivered[0];
    if (!completed?.final || completed.status === "blocked") throw new Error("Runtime did not accept a completed finish result");
    if (!completed.final.text.trim()) throw new Error("Smoke result did not include final text");
    const trace = [
      `model_steps:${modelSteps}`,
      `finish:${completed.final.status}`,
      "plain_text_finish",
      ...(search ? [completed.history.some((item) => item.type === "web_search_call") ? "web_search_call" : "missing_web_search_call"] : []),
    ];
    if (search && !completed.history.some((item) => item.type === "web_search_call")) throw new Error("No hosted web_search_call was observed");
    return {
      scenario, status: "passed", runStatus: "completed", layer: search ? "evidence" : "runtime",
      durationMs: Date.now() - started, trace, sideEffects: emptySideEffects(),
    };
  } catch (error) {
    const code = error instanceof AgentModelError ? error.code : error instanceof Error ? error.message : "unknown smoke failure";
    return {
      scenario, status: "failed", runStatus: store.list()[0]?.status ?? null,
      layer: error instanceof AgentModelError ? "model_protocol" : "runtime", durationMs: Date.now() - started,
      trace: [`model_steps:${modelSteps}`], sideEffects: emptySideEffects(), error: code,
    };
  } finally {
    await runtime.stop();
    store.close();
  }
}

export async function runAgentLoopSmoke(options: AgentLoopSmokeOptions): Promise<AgentTestReport> {
  const started = Date.now();
  const scenarios = [await runScenario(options, false), await runScenario(options, true)];
  return {
    kind: "agent_loop_smoke",
    status: scenarios.every((scenario) => scenario.status === "passed") ? "passed" : "failed",
    durationMs: Date.now() - started,
    scenarios,
  };
}

async function main(): Promise<void> {
  const { loadConfig } = await import("../config.js");
  const config = loadConfig();
  const requestedUserId = process.argv[2] ? Number(process.argv[2]) : config.agentSmokeUserId;
  const model = process.argv[3] ?? config.agentSmokeModel;
  if (!Number.isSafeInteger(requestedUserId) || !requestedUserId || !model) {
    throw new Error("Usage: node --env-file=.env dist/agent/loop-smoke.js [TELEGRAM_USER_ID] [MODEL]");
  }
  if (!config.agentEnabled) throw new Error("Agent Loop is disabled");
  if (!config.agentWebSearch) throw new Error("Hosted Web Search is disabled");
  const client = new APIMasterClient({
    baseUrl: config.apimasterBaseUrl,
    internalBaseUrl: config.apimasterInternalBaseUrl,
    identityBaseUrl: config.apimasterIdentityBaseUrl,
    serviceKey: config.miaInternalServiceKey,
    timeoutMs: 60_000,
  });
  const report = await runAgentLoopSmoke({ client, baseUrl: config.apimasterBaseUrl, userId: requestedUserId, model, timeoutMs: config.agentTimeoutMs });
  console.log(reportSummary(report));
  console.log(JSON.stringify(report));
  if (report.status === "failed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    console.error(JSON.stringify({ kind: "agent_loop_smoke", status: "failed", error: error instanceof Error ? error.message : "unknown smoke failure" }));
    process.exitCode = 1;
  });
}
