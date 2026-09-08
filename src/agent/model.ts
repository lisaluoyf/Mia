import { z } from "zod";
import type { Item, ModelStep, ToolDefinition } from "./types.js";

const responseSchema = z.object({
  status: z.literal("completed"),
  output: z.array(z.record(z.string(), z.unknown())).min(1),
});
const callSchema = z.object({ type: z.literal("function_call"), call_id: z.string().min(1), name: z.string().min(1), arguments: z.string().max(32_000) });

export class AgentModelError extends Error {
  constructor(public readonly code: string, public readonly retryable: boolean, public readonly status?: number) {
    super(code);
  }
}

export async function responseStep(options: {
  baseUrl: string; apiKey: string; model: string; instructions: string;
  input: Item[]; tools: ToolDefinition[]; signal: AbortSignal;
  timeoutMs: number; fetcher?: typeof fetch; webSearch?: boolean;
}): Promise<ModelStep> {
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(`${options.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
      body: JSON.stringify({
        model: options.model, instructions: options.instructions, input: options.input,
        tools: [...options.tools, ...(options.webSearch ? [{ type: "web_search" }] : [])],
        parallel_tool_calls: false, store: false, stream: false,
        include: ["reasoning.encrypted_content"], max_output_tokens: 4096,
      }),
    });
  } catch {
    if (options.signal.aborted) throw options.signal.reason;
    throw new AgentModelError("model_transport_error", true);
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const parsed = z.object({ error: z.object({ code: z.string().optional(), type: z.string().optional() }) }).safeParse(body);
    const code = parsed.success ? parsed.data.error.code ?? parsed.data.error.type : undefined;
    // Provider messages can contain keys or routing internals. Keep only a code.
    throw new AgentModelError(code?.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 100) || "model_request_failed",
      response.status === 408 || response.status === 429 || response.status >= 500, response.status);
  }
  const text = await response.text();
  if (text.length > 250_000) throw new AgentModelError("model_output_too_large", false);
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new AgentModelError("invalid_model_output", true); }
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new AgentModelError("incomplete_model_output", true);
  const calls = [];
  for (const item of parsed.data.output) {
    if (item.type === "function_call") {
      const call = callSchema.safeParse(item);
      if (!call.success) throw new AgentModelError("invalid_tool_call", true);
      calls.push(call.data);
    }
    if (Array.isArray(item.content) && (item.content as unknown[]).some(part => typeof part === "object" && part !== null && "type" in part && part.type === "refusal")) {
      throw new AgentModelError("model_refusal", false);
    }
  }
  if (new Set(calls.map(call => call.call_id)).size !== calls.length) throw new AgentModelError("duplicate_tool_call", true);
  return { output: parsed.data.output, calls };
}
