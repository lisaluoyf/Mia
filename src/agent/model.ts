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
  onProgress?: (phase: "started" | "receiving") => Promise<void> | void;
}): Promise<ModelStep> {
  const deadline = AbortSignal.timeout(options.timeoutMs);
  let response: Response;
  try {
    await options.onProgress?.("started");
    response = await (options.fetcher ?? fetch)(`${options.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.any([options.signal, deadline]),
      body: JSON.stringify({
        model: options.model, instructions: options.instructions, input: options.input,
        tools: [...options.tools, ...(options.webSearch ? [{ type: "web_search" }] : [])],
        parallel_tool_calls: false, store: false, stream: true,
        include: ["reasoning.encrypted_content"], max_output_tokens: 4096,
      }),
    });
  } catch {
    if (options.signal.aborted) throw options.signal.reason;
    if (deadline.aborted) throw new AgentModelError("model_timeout", true);
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
  let body: unknown;
  try {
    body = await completedResponse(response, options.onProgress);
  } catch (error) {
    if (error instanceof AgentModelError) throw error;
    throw new AgentModelError("invalid_model_output", true);
  }
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

async function completedResponse(
  response: Response,
  onProgress?: (phase: "started" | "receiving") => Promise<void> | void,
): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    const text = await response.text();
    if (text.length > 250_000) throw new AgentModelError("model_output_too_large", false);
    try { return JSON.parse(text) as unknown; } catch { throw new AgentModelError("invalid_model_output", true); }
  }
  if (!response.body) throw new AgentModelError("incomplete_model_output", true);
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let pending = "";
  let received = false;
  let completed: unknown = null;
  let receivedBytes = 0;

  const consume = async (frame: string): Promise<void> => {
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let event: unknown;
    try { event = JSON.parse(data); } catch { return; }
    received = true;
    await onProgress?.("receiving");
    if (typeof event !== "object" || event === null) return;
    const value = event as Record<string, unknown>;
    if (value.type === "response.completed" && typeof value.response === "object" && value.response !== null) {
      completed = value.response;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > 250_000) throw new AgentModelError("model_output_too_large", false);
    pending += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
    let boundary: number;
    while ((boundary = pending.indexOf("\n\n")) >= 0) {
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      await consume(frame);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) await consume(pending);
  if (!received || completed === null) throw new AgentModelError("incomplete_model_output", true);
  return completed;
}
