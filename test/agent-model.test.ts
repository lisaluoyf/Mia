import { describe, expect, it, vi } from "vitest";
import { responseStep } from "../src/agent/model.js";

const options = { baseUrl: "https://example.invalid", apiKey: "test-key", model: "configured-model", instructions: "test", input: [], tools: [], signal: new AbortController().signal, timeoutMs: 1000 };
describe("native agent Responses contract", () => {
  it("preserves reasoning and function items and disables parallel actions", async () => {
    const output = [{ type: "reasoning", id: "r1", encrypted_content: "opaque" }, { type: "function_call", call_id: "c1", name: "lookup", arguments: "{}" }];
    const fetcher = vi.fn().mockResolvedValue(Response.json({ status: "completed", output }));
    expect(await responseStep({ ...options, fetcher })).toMatchObject({ output, calls: [{ call_id: "c1", name: "lookup" }] });
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    const body: unknown = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "configured-model", parallel_tool_calls: false, store: false, include: ["reasoning.encrypted_content"] });
  });
  it.each(["incomplete", "failed", "cancelled", "in_progress"])("rejects %s as a completed model step", async status => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ status, output: [{ type: "message", content: [] }] }));
    await expect(responseStep({ ...options, fetcher })).rejects.toMatchObject({ code: "incomplete_model_output" });
  });
  it("preserves a safe provider code without leaking the error message", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { code: "insufficient_quota", message: "secret-key" } }, { status: 403 }));
    await expect(responseStep({ ...options, fetcher })).rejects.toMatchObject({ code: "insufficient_quota", status: 403, retryable: false, message: "insufficient_quota" });
  });
  it("distinguishes throttling from quota failures", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 }));
    await expect(responseStep({ ...options, fetcher })).rejects.toMatchObject({ retryable: true, code: "rate_limit_exceeded" });
  });
  it("rejects duplicate call identities", async () => {
    const item = { type: "function_call", call_id: "c1", name: "lookup", arguments: "{}" };
    const fetcher = vi.fn().mockResolvedValue(Response.json({ status: "completed", output: [item, item] }));
    await expect(responseStep({ ...options, fetcher })).rejects.toMatchObject({ code: "duplicate_tool_call" });
  });
});
