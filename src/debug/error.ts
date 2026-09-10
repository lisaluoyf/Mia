import { ChatCompletionError } from "../clients/apimaster.js";

export function debugFailureDetails(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof ChatCompletionError)) return undefined;
  return {
    upstreamError: error.upstream ?? {
      endpoint: null,
      status: error.status ?? null,
      statusText: null,
      requestId: null,
      code: error.code ?? null,
      message: null,
      body: null,
    },
  };
}

export function debugFailureCode(error: unknown): string {
  if (error instanceof ChatCompletionError) return error.code ?? error.name;
  if (error instanceof Error && error.name) return error.name.slice(0, 80);
  return "unknown_error";
}
