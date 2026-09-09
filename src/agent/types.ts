import type { MediaInput } from "../media/types.js";
import type { MediaExecutionBlock } from "../media/execution-feedback.js";

export type RunStatus = "queued" | "running" | "waiting_tool" | "waiting_input" | "waiting_approval" | "blocked" | "completed" | "cancelled";
export type Item = Record<string, unknown>;
export interface AgentInput {
  key: string;
  userId: number;
  chatId: number;
  threadId: number | null;
  messageId: number;
  replyToMessageId: number | null;
  language: string;
  text: string;
  media: MediaInput[];
  context: string;
}
export interface ToolCall { call_id: string; name: string; arguments: string }
export interface ModelStep { output: Item[]; calls: ToolCall[] }
export interface ToolResult {
  status: "succeeded" | "failed" | "pending" | "unknown";
  data?: unknown;
  error?: { code: string; message: string; retryable: boolean };
  jobId?: number;
  artifact?: { jobId: number; kind: "image" | "video"; revision: number };
  executionBlock?: MediaExecutionBlock;
}
export interface Operation {
  id: string;
  call: ToolCall;
  revision: number;
  state: "prepared" | "approval" | "executing" | "waiting" | "done";
  approved: boolean;
  expiresAt: number;
  draftJobId?: number;
  binding?: { model: string; capabilities: string };
  result?: ToolResult;
}
export interface Run {
  id: string;
  scope: string;
  input: AgentInput;
  status: RunStatus;
  revision: number;
  history: Item[];
  operations: Operation[];
  steps: number;
  attempts: number;
  nextAt: number;
  notice: string | null;
  noticeVersion: number;
  noticeMessageId: number | null;
  final: { text: string; status: "completed" | "waiting_input" | "blocked"; revision: number; executionBlock?: MediaExecutionBlock } | null;
  updatedAt: number;
}
export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: true;
}
export interface AgentTool {
  definition: ToolDefinition;
  paid: boolean;
  alwaysApprove?: boolean;
  createApprovalDraft?: (run: Run, operation: Operation) => Promise<number>;
  prepare?: (run: Run, operation: Operation) => Promise<void>;
  execute: (run: Run, operation: Operation, signal: AbortSignal, current: () => boolean) => Promise<ToolResult>;
  recover?: (run: Run, operation: Operation) => Promise<ToolResult | null>;
  cancel?: (run: Run, operation: Operation) => void;
}
export function scopeKey(input: Pick<AgentInput, "chatId" | "threadId" | "userId">): string {
  return `${input.chatId}:${input.threadId ?? 0}:${input.userId}`;
}
export function toolOutput(callId: string, result: unknown): Item {
  return { type: "function_call_output", call_id: callId, output: JSON.stringify(result) };
}
