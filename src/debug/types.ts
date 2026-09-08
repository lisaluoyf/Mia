export type DebugRequestKind =
  | "chat"
  | "intent_router"
  | "vision_qa"
  | "image_generate"
  | "image_edit"
  | "video_generate"
  | "memory_compaction"
  | "group_compaction";

export type DebugRequestStatus = "running" | "succeeded" | "failed" | "submitted";

export interface DebugPromptRef {
  id: string;
  version: number;
}

export interface DebugContextLayers {
  systemRules: unknown;
  conversation: unknown;
  longTermMemory: unknown;
  rollingSummary: unknown;
  recentMessages: unknown;
}

export interface DebugRequest {
  id: string;
  telegramUserId: number;
  chatId: number | null;
  chatType: string | null;
  messageId: number | null;
  kind: DebugRequestKind;
  model: string;
  status: DebugRequestStatus;
  durationMs: number | null;
  promptRefs: DebugPromptRef[];
  contextLayers: DebugContextLayers | null;
  requestPreview: unknown;
  responsePreview: unknown;
  media: unknown;
  details: unknown;
  taskId: string | null;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface StartDebugRequest {
  telegramUserId: number;
  chatId?: number | null;
  chatType?: string | null;
  messageId?: number | null;
  kind: DebugRequestKind;
  model: string;
  promptRefs?: readonly DebugPromptRef[];
  contextLayers?: DebugContextLayers | null;
  requestPreview?: unknown;
  media?: unknown;
  details?: unknown;
  taskId?: string | null;
  externalKey?: string | null;
}

export interface FinishDebugRequest {
  status: Exclude<DebugRequestStatus, "running">;
  responsePreview?: unknown;
  details?: unknown;
  taskId?: string | null;
  errorCode?: string | null;
  kind?: DebugRequestKind;
}
