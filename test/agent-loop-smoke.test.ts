import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentLoopSmoke } from "../src/agent/loop-smoke.js";

function finish(search: boolean) {
  return {
    type: "function_call", call_id: search ? "search-finish" : "text-finish", name: "finish",
    arguments: JSON.stringify({
      status: "completed", text: search ? "Hosted search OK" : "Text OK",
      requirements: [{ requirement: search ? "Current facts" : "Text check", kind: search ? "search" : "text", satisfied: true, evidence: search ? ["turn1view5"] : [] }],
    }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Agent Loop production smoke", () => {
  it("runs text and hosted search through Runtime without Telegram or media dependencies", async () => {
    const requests: Array<{ webSearch: boolean; toolNames: string[] }> = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
      const body = JSON.parse(init.body) as { tools: Array<{ type: string; name?: string }> };
      const webSearch = body.tools.some((tool) => tool.type === "web_search");
      requests.push({ webSearch, toolNames: body.tools.map((tool) => tool.name ?? tool.type) });
      const final = finish(webSearch);
      return Promise.resolve(Response.json({
        status: "completed",
        output: webSearch
          ? [{ type: "web_search_call", id: "ws_1", action: { type: "search", query: "official OpenAI news" } }, final]
          : [final],
      }));
    }));
    const client = { resolveAPIKey: vi.fn().mockResolvedValue("test-key") };
    const report = await runAgentLoopSmoke({
      client,
      baseUrl: "https://example.invalid",
      userId: 42,
      model: "gpt-5.6-luna",
      timeoutMs: 1_000,
    });
    expect(report.status).toBe("passed");
    expect(report.scenarios.map((scenario) => scenario.scenario)).toEqual(["production_text", "production_hosted_search"]);
    expect(report.scenarios.every((scenario) => scenario.sideEffects.telegramMessages === 0 && scenario.sideEffects.mediaJobs === 0 && scenario.sideEffects.paidSubmissions === 0)).toBe(true);
    expect(requests).toEqual([
      { webSearch: false, toolNames: ["finish"] },
      { webSearch: true, toolNames: ["finish", "web_search"] },
    ]);
    expect(client.resolveAPIKey).toHaveBeenCalledTimes(2);
  });
});
