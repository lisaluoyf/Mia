import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../src/agent/runtime.js";
import { AgentStore } from "../src/agent/store.js";
import { AgentModelError } from "../src/agent/model.js";
import type { AgentInput, AgentTool, ModelStep, Run, ToolResult } from "../src/agent/types.js";
import { miaResponseFromText, miaResponsePlainText, type MiaResponse } from "../src/presentation/schema.js";

const input: AgentInput = { key: "1", userId: 42, chatId: 42, threadId: null, messageId: 1, replyToMessageId: null, language: "en", text: "Help me", media: [], context: "" };
function call(name: string, args: unknown = {}, id = "call-1"): ModelStep {
  const item = { type: "function_call", name, arguments: JSON.stringify(args), call_id: id };
  return { calls: [item], output: [item] };
}
function finish(evidence: string[] = [], kind = "text", status = "completed"): ModelStep {
  return call("finish", { text: "Here is the result", status, requirements: [{ requirement: "User goal", kind, satisfied: status === "completed", evidence }] }, "finish-1");
}
const baseTool = (execute = vi.fn().mockResolvedValue({ status: "succeeded", data: "result" })): AgentTool => ({
  definition: { type: "function", name: "lookup", description: "Lookup", parameters: {}, strict: true }, paid: false, execute,
});
const stores: AgentStore[] = [];
const runtimes: AgentRuntime[] = [];
function setup(model: (run: Run) => ModelStep | Promise<ModelStep>, tools: AgentTool[] = []) {
  const store = new AgentStore(":memory:"); stores.push(store);
  const deliver = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn().mockResolvedValue(100);
  const modelMock = vi.fn((run: Run) => Promise.resolve(model(run)));
  const runtime = new AgentRuntime({ store, tools, model: modelMock, deliver, notify, logger: { warn: vi.fn(), info: vi.fn() } });
  runtimes.push(runtime);
  return { store, runtime, deliver, notify, model: modelMock };
}
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.stop(); for (const store of stores.splice(0)) store.close(); });

describe("goal-driven agent runtime", () => {
  it.each<MiaResponse | null>([
    null,
    { ...miaResponseFromText("Body"), title: { text: "Result", emoji: null } },
    { version: 1, title: null, actions: [], blocks: [{ type: "table", heading: "Comparison", emoji: null, columns: ["Item", "Status"], rows: [["Schema", "OK"]], compact: false }] },
  ])("validates and delivers nullable rich finish output %#", async presentation => {
    const f = setup(() => call("finish", { status: "completed", text: "Plain answer", presentation, requirements: [{ requirement: "Answer", kind: "text", satisfied: true, evidence: [] }] }));
    f.runtime.enqueue(input); await f.runtime.drain();
    expect(f.deliver).toHaveBeenCalledTimes(1);
    const delivered = f.deliver.mock.calls[0]![0] as Run;
    expect(delivered.final?.text).toBe(presentation ? miaResponsePlainText(presentation) : "Plain answer");
    expect(delivered.final?.presentation).toEqual(presentation ?? undefined);
  });
  it("finishes ordinary text in one model step and deduplicates input", async () => {
    const f = setup(() => finish());
    f.runtime.enqueue(input); await f.runtime.drain();
    f.runtime.enqueue(input); await f.runtime.drain();
    expect(f.model).toHaveBeenCalledTimes(1);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.store.list()).toEqual([]);
  });
  it("feeds tool errors back, repairs the request and verifies evidence", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ status: "failed", error: { code: "unknown_provider_error", message: "Try another query", retryable: false } }).mockResolvedValue({ status: "succeeded", data: "answer" });
    const f = setup(run => run.operations.length < 2 ? call("lookup", { query: run.operations.length ? "revised" : "first" }, `call-${run.operations.length}`) : finish([run.operations[1]!.id]), [baseTool(execute)]);
    f.runtime.enqueue(input); await f.runtime.drain();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(f.model).toHaveBeenCalledTimes(3);
    const history = f.model.mock.calls[1]?.[0].history;
    expect(JSON.stringify(history)).toContain("unknown_provider_error");
    expect(f.deliver).toHaveBeenCalledTimes(1);
  });
  it("does not treat progress text or missing artifact evidence as completion", async () => {
    let count = 0;
    const f = setup(() => ++count === 1 ? { output: [{ type: "message", content: [{ type: "output_text", text: "I will generate it" }] }], calls: [] } : finish([], "image"));
    f.runtime.enqueue(input); await f.runtime.drain();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.model).toHaveBeenCalledTimes(8);
    expect(f.store.list()[0]?.status).toBe("blocked");
  });
  it("waits without model polling, resumes once and returns async evidence", async () => {
    let ready = false;
    const tool = baseTool(vi.fn().mockResolvedValue({ status: "pending", jobId: 7 }));
    tool.recover = vi.fn((): Promise<ToolResult> => Promise.resolve(ready ? { status: "succeeded", data: "done" } : { status: "pending", jobId: 7 }));
    const f = setup(run => run.operations.length ? finish([run.operations[0]!.id]) : call("lookup"), [tool]);
    f.runtime.enqueue(input); await f.runtime.drain();
    await f.runtime.drain(); await f.runtime.drain();
    expect(f.model).toHaveBeenCalledTimes(1);
    ready = true;
    await f.runtime.drain(); await f.runtime.drain();
    expect(f.model).toHaveBeenCalledTimes(2);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(tool.execute).toHaveBeenCalledTimes(1);
    const delivered = f.deliver.mock.calls[0]![0] as Run;
    expect(delivered.history.filter(item => item.type === "function_call_output" && item.call_id === "call-1")).toHaveLength(1);
    expect(JSON.stringify(delivered.history)).toContain("Asynchronous tool completion");
  });
  it("does not execute stale model output after a new user requirement", async () => {
    let release!: (value: ModelStep) => void;
    const tool = baseTool();
    let count = 0;
    const f = setup(async () => ++count === 1 ? new Promise(resolve => { release = resolve; }) : finish(), [tool]);
    f.runtime.enqueue(input);
    f.runtime.enqueue({ ...input, key: "2", messageId: 2, text: "Actually make it 16:9" });
    release(call("lookup"));
    await f.runtime.drain(); await f.runtime.drain();
    expect(tool.execute).not.toHaveBeenCalled();
    expect((f.deliver.mock.calls[0]![0] as Run).history).toContainEqual({ role: "user", content: "Actually make it 16:9" });
  });
  it("invalidates old approvals and enforces owner and topic", async () => {
    const tool = { ...baseTool(), paid: true, alwaysApprove: true };
    const f = setup(run => call("lookup", { revision: run.revision }), [tool]);
    f.runtime.enqueue(input); await f.runtime.drain();
    const run = f.store.list()[0]!;
    expect(run.status).toBe("waiting_approval");
    expect(f.runtime.approve(run.id, run.revision, 9, 42, null)).toBe(false);
    expect(f.runtime.approve(run.id, run.revision, 42, 42, 7)).toBe(false);
    f.runtime.enqueue({ ...input, key: "2", text: "Change the size" }); await f.runtime.drain();
    expect(f.runtime.approve(run.id, run.revision, 42, 42, null)).toBe(false);
    expect(tool.execute).not.toHaveBeenCalled();
  });
  it("requires approval before an additional paid operation", async () => {
    const tool = { ...baseTool(), paid: true };
    const f = setup(run => call("lookup", { attempt: run.operations.length }, `c${run.operations.length}`), [tool]);
    f.runtime.enqueue(input); await f.runtime.drain();
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(f.store.list()[0]?.status).toBe("waiting_approval");
  });
  it("cancels pending work without another model call", async () => {
    const tool = baseTool(vi.fn().mockResolvedValue({ status: "pending", jobId: 1 }));
    tool.recover = vi.fn().mockResolvedValue({ status: "pending", jobId: 1 });
    tool.cancel = vi.fn();
    const f = setup(() => call("lookup"), [tool]);
    f.runtime.enqueue(input); await f.runtime.drain();
    f.runtime.enqueue({ ...input, key: "2", text: "cancel" }); await f.runtime.drain();
    expect(tool.cancel).toHaveBeenCalledTimes(1);
    expect(f.model).toHaveBeenCalledTimes(1);
    expect(f.store.list()).toHaveLength(0);
    expect(f.notify).toHaveBeenLastCalledWith(expect.objectContaining({ status: "cancelled" }));
  });
  it("resumes a persisted executing paid operation by recovery, never re-execution", async () => {
    const tool = { ...baseTool(), paid: true, recover: vi.fn().mockResolvedValue({ status: "pending", jobId: 2 }) };
    const f = setup(() => call("lookup"), [tool]);
    f.runtime.enqueue(input); await f.runtime.drain();
    const run = f.store.list()[0]!;
    // Restore the crash checkpoint taken immediately before tool submission.
    run.operations[0]!.state = "executing";
    run.history = run.history.filter(item => item.type !== "function_call_output");
    run.status = "running";
    f.store.save(run);
    await f.runtime.drain();
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(f.store.get(run.id)?.operations[0]?.state).toBe("waiting");
    expect(f.store.get(run.id)?.history.filter(item => item.type === "function_call_output")).toHaveLength(1);
  });
  it("caps repeated actions without new evidence", async () => {
    const tool = baseTool(vi.fn().mockResolvedValue({ status: "failed", error: { code: "unavailable", message: "unavailable", retryable: false } }));
    const f = setup(run => call("lookup", {}, `c${run.operations.length}`), [tool]);
    f.runtime.enqueue(input); await f.runtime.drain();
    expect(tool.execute).toHaveBeenCalledTimes(3);
    expect(f.store.list()[0]?.status).toBe("blocked");
  });
  it("keeps different users and topics isolated", async () => {
    const f = setup(() => finish([], "text", "waiting_input"));
    f.runtime.enqueue({ ...input, chatId: -100, threadId: 1 });
    f.runtime.enqueue({ ...input, key: "2", chatId: -100, threadId: 2 });
    f.runtime.enqueue({ ...input, key: "3", chatId: -100, threadId: 1, userId: 43 });
    await f.runtime.drain();
    expect(f.store.list()).toHaveLength(3);
    expect(new Set(f.store.list().map(run => run.scope)).size).toBe(3);
  });
  it("persists transient model backoff and stops after two retries", async () => {
    const f = setup(() => { throw new AgentModelError("transport", true); });
    f.runtime.enqueue(input); await f.runtime.drain();
    expect(f.store.list()[0]?.attempts).toBe(1);
    await f.runtime.drain();
    expect(f.model).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 2; i++) { const run = f.store.list()[0]!; run.nextAt = 0; f.store.save(run); await f.runtime.drain(); }
    expect(f.model).toHaveBeenCalledTimes(3);
    expect(f.store.list()[0]?.status).toBe("blocked");
  });
  it("feeds unexpected tool exceptions into the loop", async () => {
    const f = setup(run => run.operations.length ? finish([], "text", "blocked") : call("lookup"), [baseTool(vi.fn().mockRejectedValue(new Error("secret upstream text")))]);
    f.runtime.enqueue(input); await f.runtime.drain();
    expect(f.model).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.store.list()[0]?.history)).toContain("tool_exception");
    expect(JSON.stringify(f.store.list()[0]?.history)).not.toContain("secret upstream text");
  });
});
