import { describe, expect, it, vi } from "vitest";
import { responseStep } from "../src/agent/model.js";
import { finishTool } from "../src/agent/runtime.js";
import { createAgentTools } from "../src/agent/tools.js";
import { MIA_RESPONSE_JSON_SCHEMA } from "../src/presentation/schema.js";

function checkStrictSchema(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(checkStrictSchema);
    return;
  }
  const schema = value as Record<string, unknown>;
  expect(schema).not.toHaveProperty("oneOf");
  if (schema.type === "object") {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining(Object.keys(schema.properties as object)));
  }
  Object.values(schema).forEach(checkStrictSchema);
}

const options = { baseUrl: "https://example.invalid", apiKey: "test-key", model: "configured-model", instructions: "test", input: [], tools: [], signal: new AbortController().signal, timeoutMs: 1000 };
describe("native agent Responses contract", () => {
  it.each([false, true])("sends provider-compatible strict schemas with web search %s", async webSearch => {
    // Definitions must not access execution dependencies while being constructed.
    const unavailable = new Proxy({}, { get() { throw new Error("Unexpected tool execution"); } });
    const tools = createAgentTools({ client: unavailable, settings: unavailable, media: unavailable, api: unavailable, botToken: "test" } as Parameters<typeof createAgentTools>[0]);
    const fetcher = vi.fn().mockResolvedValue(Response.json({ status: "completed", output: [{ type: "message", content: [] }] }));
    await responseStep({ ...options, tools: [...tools.map(tool => tool.definition), finishTool], webSearch, fetcher });
    const body = JSON.parse((fetcher.mock.calls[0]![1] as RequestInit).body as string) as { tools: Array<typeof finishTool | { type: "web_search" }> };
    expect(body.tools).toHaveLength(webSearch ? 9 : 8);
    for (const tool of body.tools) {
      if (tool.type === "web_search") continue;
      expect(tool.strict).toBe(true);
      checkStrictSchema(tool.parameters);
    }
    expect(body.tools.filter(tool => tool.type === "web_search")).toHaveLength(webSearch ? 1 : 0);
    const finish = body.tools.find((tool): tool is typeof finishTool => tool.type === "function" && tool.name === "finish")?.parameters;
    expect(finish?.required).toEqual(expect.arrayContaining(["status", "text", "presentation", "requirements"]));
    expect(finish).toMatchObject({
      properties: { presentation: { anyOf: [MIA_RESPONSE_JSON_SCHEMA, { type: "null" }] } },
    });
  });
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
  it("reports its own deadline separately from transport failures", async () => {
    const fetcher = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      return Response.json({});
    });
    await expect(responseStep({ ...options, timeoutMs: 1, fetcher })).rejects.toMatchObject({ code: "model_timeout", retryable: true });
  });
  it("rejects duplicate call identities", async () => {
    const item = { type: "function_call", call_id: "c1", name: "lookup", arguments: "{}" };
    const fetcher = vi.fn().mockResolvedValue(Response.json({ status: "completed", output: [item, item] }));
    await expect(responseStep({ ...options, fetcher })).rejects.toMatchObject({ code: "duplicate_tool_call" });
  });
});
