import { AgentModelError } from "./model.js";
import { GrammyError, type Api } from "grammy";
import { AgentRuntime } from "./runtime.js";
import { AgentStore } from "./store.js";
import { sendAgentChunk } from "./presentation.js";
import { renderTelegramRich } from "../presentation/telegram-rich.js";
import { miaResponseFromText } from "../presentation/schema.js";
import type { AgentInput, AgentTool, ModelStep, Run, ToolResult } from "./types.js";
import { emptySideEffects, reportSummary, type AgentTestReport, type AgentTestScenarioReport } from "./test-report.js";

const input: AgentInput = {
  key: "agent-loop-test:1", userId: 42, chatId: 42, threadId: null, messageId: 1,
  replyToMessageId: null, language: "en", text: "Run the recorded test task", media: [], context: "",
};

function toolCall(name: string, argumentsValue: unknown = {}, callId = "call-1"): ModelStep {
  const item = { type: "function_call", name, arguments: JSON.stringify(argumentsValue), call_id: callId };
  return { output: [item], calls: [item] };
}

function finishStep(options: { presentation?: boolean; search?: boolean; evidence?: string[]; status?: "completed" | "waiting_input" | "blocked" } = {}): ModelStep {
  const status = options.status ?? "completed";
  const presentation = options.presentation ? { ...miaResponseFromText("Recorded agent result"), title: { text: "Recorded result", emoji: null } } : null;
  return toolCall("finish", {
    status,
    text: "Recorded agent result",
    presentation,
    requirements: [{
      requirement: options.search ? "Current information" : "Recorded task",
      kind: options.search ? "search" : "text",
      satisfied: status === "completed",
      evidence: options.evidence ?? (options.search ? ["turn1view5"] : []),
    }],
  }, "finish-1");
}

interface Fixture {
  store: AgentStore;
  runtime: AgentRuntime;
  delivered: Run[];
  notices: Run[];
  calls: string[];
}

function fixture(model: (run: Run, signal: AbortSignal) => Promise<ModelStep> | ModelStep, tools: AgentTool[] = []): Fixture {
  const store = new AgentStore(":memory:");
  const delivered: Run[] = [];
  const notices: Run[] = [];
  const calls: string[] = [];
  const runtime = new AgentRuntime({
    store,
    tools,
    model: (run, _history, _definitions, signal) => {
      calls.push(`step:${run.steps}`);
      return Promise.resolve(model(run, signal));
    },
    notify: (run) => { notices.push(structuredClone(run)); return Promise.resolve(1); },
    deliver: (run) => { delivered.push(structuredClone(run)); return Promise.resolve(); },
    logger: { info: () => undefined, warn: () => undefined },
  });
  return { store, runtime, delivered, notices, calls };
}

async function close(f: Fixture): Promise<void> {
  await f.runtime.stop();
  f.store.close();
}

function remaining(f: Fixture): Run | null { return f.store.list()[0] ?? null; }

async function scenario(
  name: string, layer: AgentTestScenarioReport["layer"],
  execute: () => Promise<{ runStatus: string | null; trace: string[]; sideEffects?: AgentTestScenarioReport["sideEffects"] }>,
): Promise<AgentTestScenarioReport> {
  const started = Date.now();
  try {
    const result = await execute();
    return { scenario: name, status: "passed", layer, durationMs: Date.now() - started, ...result, sideEffects: result.sideEffects ?? emptySideEffects() };
  } catch (error) {
    return {
      scenario: name, status: "failed", runStatus: null, layer, durationMs: Date.now() - started,
      trace: [], sideEffects: emptySideEffects(), error: error instanceof Error ? error.message : "unknown test failure",
    };
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function lookupTool(execute: AgentTool["execute"], options: Partial<AgentTool> = {}): AgentTool {
  return {
    definition: { type: "function", name: "lookup", description: "Recorded non-paid lookup", parameters: { type: "object", properties: {}, additionalProperties: false, required: [] }, strict: true },
    paid: false,
    execute,
    ...options,
  };
}

export async function runAgentLoopTest(): Promise<AgentTestReport> {
  const started = Date.now();
  const scenarios: AgentTestScenarioReport[] = [];
  scenarios.push(await scenario("text_rich_delivery", "delivery", async () => {
    const f = fixture(() => finishStep({ presentation: true }));
    try {
      f.runtime.enqueue(input); await f.runtime.drain();
      expect(f.delivered.length === 1, "Expected exactly one final delivery");
      expect(f.delivered[0]?.final?.presentation?.title?.text === "Recorded result", "Expected structured rich presentation");
      return { runStatus: "completed", trace: [...f.calls, "rich_presentation_rendered"] };
    } finally { await close(f); }
  }));
  scenarios.push(await scenario("hosted_search_provider_source", "evidence", async () => {
    const hostedSearch = { type: "web_search_call", id: "ws_1", action: { type: "search", query: "recorded query" } };
    const f = fixture(() => {
      const finish = finishStep({ search: true });
      return { output: [hostedSearch, finish.output[0]!], calls: finish.calls };
    });
    try {
      f.runtime.enqueue(input); await f.runtime.drain();
      expect(f.delivered.length === 1, "Hosted search with provider-owned source ID was rejected");
      return { runStatus: "completed", trace: ["web_search_call", "provider_source:turn1view5", "finish_accepted"] };
    } finally { await close(f); }
  }));
  scenarios.push(await scenario("search_without_execution_is_blocked", "evidence", async () => {
    const f = fixture(() => finishStep({ search: true }));
    try {
      f.runtime.enqueue(input); await f.runtime.drain();
      const run = remaining(f);
      expect(run?.status === "blocked", "Search claim without web_search_call must block delivery");
      expect(f.delivered.length === 0, "Search claim without execution was delivered");
      return { runStatus: run.status, trace: ["finish_rejected:no_web_search_call", `steps:${run.steps}`] };
    } finally { await close(f); }
  }));
  scenarios.push(await scenario("tool_failure_repairs_in_loop", "tool", async () => {
    let attempts = 0;
    const tool = lookupTool((): Promise<ToolResult> => {
      attempts += 1;
      return Promise.resolve(attempts === 1
        ? { status: "failed", error: { code: "channel_unavailable", message: "Recorded channel failure", retryable: false } }
        : { status: "succeeded", data: { answer: "repaired" } });
    });
    const f = fixture((run) => run.operations.length < 2
      ? toolCall("lookup", { attempt: run.operations.length }, `lookup-${run.operations.length}`)
      : finishStep({ evidence: [run.operations[1]!.id] }), [tool]);
    try {
      f.runtime.enqueue(input); await f.runtime.drain();
      expect(attempts === 2 && f.delivered.length === 1, "Tool failure did not lead to a repaired result");
      return { runStatus: "completed", trace: ["channel_unavailable", "revised_tool_call", "finish_accepted"] };
    } finally { await close(f); }
  }));
  scenarios.push(await scenario("provider_failures_are_explained", "model_protocol", async () => {
    const codes = ["model_request_failed", "rate_limit_exceeded", "insufficient_quota", "model_timeout", "model_transport_error"];
    for (const code of codes) {
      const f = fixture(() => { throw new AgentModelError(code, false); });
      try {
        f.runtime.enqueue(input); await f.runtime.drain();
        const run = remaining(f);
        expect(run?.status === "blocked" && run.notice?.includes(code), `Missing user-safe feedback for ${code}`);
        expect(f.delivered.length === 0, `${code} incorrectly delivered a result`);
      } finally { await close(f); }
    }
    return { runStatus: "blocked", trace: codes.map((code) => `blocked:${code}`) };
  }));
  scenarios.push(await scenario("new_input_supersedes_stale_output", "runtime", async () => {
    let resolveFirst: (step: ModelStep) => void = () => { throw new Error("First recorded response did not start"); };
    const firstResponse = new Promise<ModelStep>((resolve) => { resolveFirst = resolve; });
    let count = 0;
    let executed = 0;
    const tool = lookupTool(() => { executed += 1; return Promise.resolve({ status: "succeeded" as const, data: {} }); });
    const f = fixture(() => {
      count += 1;
      if (count === 1) return firstResponse;
      return finishStep();
    }, [tool]);
    try {
      f.runtime.enqueue(input);
      f.runtime.enqueue({ ...input, key: "agent-loop-test:2", messageId: 2, text: "Actually use 16:9" });
      resolveFirst(toolCall("lookup"));
      await f.runtime.drain(); await f.runtime.drain();
      expect(executed === 0, "Stale tool output was executed after a new user input");
      expect(f.delivered.length === 1 && f.delivered[0]?.history.some((item) => item.role === "user" && item.content === "Actually use 16:9"), "Latest input was not retained");
      return { runStatus: "completed", trace: ["first_model_aborted", "revision:2", "stale_tool_skipped"] };
    } finally { await close(f); }
  }));
  scenarios.push(await scenario("cancel_stops_pending_work", "runtime", async () => {
    const tool = lookupTool(() => Promise.resolve({ status: "pending" as const, jobId: 7 }), { recover: () => Promise.resolve({ status: "pending" as const, jobId: 7 }), cancel: () => undefined });
    const f = fixture(() => toolCall("lookup"), [tool]);
    try {
      f.runtime.enqueue(input); await f.runtime.drain();
      f.runtime.enqueue({ ...input, key: "agent-loop-test:cancel", text: "/cancel" }); await f.runtime.drain();
      expect(remaining(f) === null, "Cancelled run remained active");
      expect(f.notices.some((run) => run.status === "cancelled"), "Cancellation was not surfaced");
      return { runStatus: "cancelled", trace: ["pending_tool", "cancelled", "no_model_resume"] };
    } finally { await close(f); }
  }));
  scenarios.push(await scenario("paid_operation_requires_approval", "tool", async () => {
    const submissions: number[] = [];
    const tool = lookupTool(() => { submissions.push(Date.now()); return Promise.resolve({ status: "succeeded" as const, data: { submitted: true } }); }, { paid: true, alwaysApprove: true });
    const f = fixture((run) => run.operations.length ? finishStep({ evidence: [run.operations[0]!.id] }) : toolCall("lookup"), [tool]);
    try {
      f.runtime.enqueue(input); await f.runtime.drain();
      const pending = remaining(f);
      expect(pending?.status === "waiting_approval" && submissions.length === 0, "Paid task was submitted before approval");
      expect(f.runtime.approve(pending.id, pending.revision, 42, 42, null), "Recorded approval was rejected");
      await f.runtime.drain();
      const totalSubmissions = Number(submissions.length);
      expect(totalSubmissions === 1 && f.delivered.length === 1, "Approved paid task did not complete once");
      return { runStatus: "completed", trace: ["waiting_approval", "approval_bound_to_revision", "submitted_once"], sideEffects: { telegramMessages: 0, mediaJobs: 1, paidSubmissions: 1 } };
    } finally { await close(f); }
  }));
  scenarios.push(await scenario("async_tool_recovers_once", "tool", async () => {
    let ready = false;
    let executions = 0;
    const tool = lookupTool(() => { executions += 1; return Promise.resolve({ status: "pending" as const, jobId: 11 }); }, { recover: () => Promise.resolve(ready ? { status: "succeeded" as const, data: "done" } : { status: "pending" as const, jobId: 11 }) });
    const f = fixture((run) => run.operations.length ? finishStep({ evidence: [run.operations[0]!.id] }) : toolCall("lookup"), [tool]);
    try {
      f.runtime.enqueue(input); await f.runtime.drain();
      ready = true;
      await f.runtime.drain(); await f.runtime.drain();
      expect(executions === 1 && f.delivered.length === 1, "Async task was not recovered exactly once");
      return { runStatus: "completed", trace: ["tool_pending", "tool_recovered", "single_submission"] };
    } finally { await close(f); }
  }));
  scenarios.push(await scenario("telegram_rich_html_plain_fallback", "delivery", async () => {
    const chunk = renderTelegramRich({ ...miaResponseFromText("Fallback body"), title: { text: "Fallback", emoji: null } })[0]!;
    const calls: string[] = [];
    const rejection = new GrammyError("unsupported", { ok: false, error_code: 400, description: "Unsupported formatting" }, "sendMessage", {});
    const api = {
      sendRichMessage: () => { calls.push("rich"); return Promise.reject(rejection); },
      sendMessage: (_chatId: number, _text: string, options?: Record<string, unknown>) => {
        calls.push(options?.parse_mode === "HTML" ? "html" : "plain");
        if (options?.parse_mode === "HTML") return Promise.reject(rejection);
        return Promise.resolve({ message_id: 1 });
      },
    };
    const sent: string[] = [];
    await sendAgentChunk(api as unknown as Api, 42, chunk, {}, async (suffix, send) => { await send(); sent.push(suffix); }, () => true);
    expect(sent.join(",") === "plain:0" && calls.join(",") === "rich,html,plain", "Rich/HTML rejection did not fall back to plain text");
    return { runStatus: "completed", trace: ["rich_rejected", "html_rejected", "plain_delivered"] };
  }));
  const report: AgentTestReport = {
    kind: "agent_loop_test",
    status: scenarios.every((item) => item.status === "passed") ? "passed" : "failed",
    durationMs: Date.now() - started,
    scenarios,
  };
  return report;
}

async function main(): Promise<void> {
  const report = await runAgentLoopTest();
  console.log(reportSummary(report));
  console.log(JSON.stringify(report));
  if (report.status === "failed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
