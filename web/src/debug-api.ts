export interface DebugPromptRef { id: string; version: number }
export interface DebugRequest {
  id: string;
  telegramUserId: number;
  chatId: number | null;
  chatType: string | null;
  messageId: number | null;
  kind: string;
  model: string;
  status: "running" | "succeeded" | "failed" | "submitted";
  durationMs: number | null;
  promptRefs: DebugPromptRef[];
  contextLayers: Record<string, unknown> | null;
  requestPreview: unknown;
  responsePreview: unknown;
  media: unknown;
  details: unknown;
  taskId: string | null;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface DebugPrompt { id: string; version: number; name: string; purpose: string; text: string }
export interface DebugMemory {
  memories: Array<{ id: number; category: string; content: string; updatedAt: string }>;
  summary: { content: string; throughMessageId: number; createdAt: string } | null;
  pendingTurns: number;
  batchSize: number;
  lastCompaction: DebugRequest | null;
  history: DebugRequest[];
}

export class DebugApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/mia/debug/${path}`, { ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) } });
  const payload = await response.json().catch(() => null) as { success?: boolean; data?: T; error?: string } | null;
  if (!response.ok || payload?.success !== true) throw new DebugApiError(response.status, payload?.error ?? "request_failed");
  return payload.data as T;
}

const promptText = `你是 Mia，一位运行在 Telegram 中的个人 AI 助理。\n\n交流风格：\n自然、有温度、聪明直接，像熟悉用户的私人助理。\n根据用户当前使用的语言回答。`;
const previewRequests: DebugRequest[] = [
  {
    id: "81e1ef7f-6ae9-4abc-9d94-905149ab35d1", telegramUserId: 7553714675, chatId: 7553714675,
    chatType: "private", messageId: 184, kind: "chat", model: "grok-4.5", status: "succeeded", durationMs: 1842,
    promptRefs: [{ id: "mia.system", version: 1 }, { id: "mia.intent-router", version: 1 }],
    contextLayers: {
      systemRules: { id: "mia.system", version: 1 },
      conversation: { chatType: "private", currentUser: "Lisa", language: "zh-CN", trigger: "message", currentTask: null },
      longTermMemory: [{ category: "identity", content: "用户希望被称为 Roma" }, { category: "goal", content: "正在开发 Telegram 个人 AI 助理 Mia" }],
      rollingSummary: "用户正在验证 Mia 的上下文记忆，并要求提供可查看真实请求快照的开发者控制台。",
      recentMessages: { order: "oldest_to_newest", currentMessageId: 184, messages: [{ messageId: 181, text: "我们刚才讨论的上下文是什么？", current: false }, { messageId: 184, replyToMessageId: 181, text: "继续第三层", current: true }], media: [] },
    },
    requestPreview: { text: "继续第三层" }, responsePreview: "第三层是用户长期记忆。", media: [], details: { phase: "intent_and_response", routedIntent: "chat" }, taskId: null, errorCode: null,
    createdAt: new Date(Date.now() - 94_000).toISOString(), completedAt: new Date(Date.now() - 92_158).toISOString(),
  },
  {
    id: "701b9f21-f269-4341-b225-c4dd4407c2c4", telegramUserId: 7553714675, chatId: -10020931,
    chatType: "supergroup", messageId: 409, kind: "image_edit", model: "gpt-image-2", status: "submitted", durationMs: 721,
    promptRefs: [], contextLayers: null, requestPreview: { instruction: "把背景换成黄昏的东京街道", options: { aspectRatio: "1:1" } }, responsePreview: { status: "submitted" },
    media: [{ messageId: 406, type: "photo", mimeType: "image/jpeg", role: "reference_image" }], details: { mediaJobId: 23, phase: "polling" }, taskId: "task_demo_23", errorCode: null,
    createdAt: new Date(Date.now() - 280_000).toISOString(), completedAt: new Date(Date.now() - 279_279).toISOString(),
  },
];

function previewData() {
  const prompts: DebugPrompt[] = [
    { id: "mia.system", version: 1, name: "Mia System", purpose: "聊天和视觉理解的基础行为规则", text: promptText },
    { id: "mia.intent-router", version: 1, name: "Intent Router", purpose: "判断聊天、看图、图片和视频意图", text: `${promptText}\n\n你还负责判断用户当前请求属于哪种操作。` },
    { id: "mia.context-compaction", version: 1, name: "Context Compaction", purpose: "每 10 轮整理长期记忆与滚动摘要", text: "你负责整理 Mia 的长期记忆和当前私聊的历史摘要。" },
  ];
  const memory: DebugMemory = {
    memories: [
      { id: 1, category: "identity", content: "用户希望被称为 Roma", updatedAt: new Date().toISOString() },
      { id: 2, category: "preference", content: "偏好简洁、直接的产品讨论", updatedAt: new Date().toISOString() },
      { id: 3, category: "goal", content: "正在开发面向 Telegram 生态的个人 AI 助理 Mia", updatedAt: new Date().toISOString() },
    ],
    summary: { content: "用户已确认 Mia 的五层上下文与每 10 轮长期记忆整理规则。", throughMessageId: 170, createdAt: new Date().toISOString() },
    pendingTurns: 7, batchSize: 10, lastCompaction: null, history: [],
  };
  return { requests: previewRequests, prompts, memory };
}

export async function loadDebugConsole(): Promise<{ requests: DebugRequest[]; prompts: DebugPrompt[]; memory: DebugMemory }> {
  const isLocalPreview = ["127.0.0.1", "localhost"].includes(location.hostname) && new URLSearchParams(location.search).get("preview") === "1";
  if (isLocalPreview) return previewData();
  const [requests, prompts, memory] = await Promise.all([
    request<DebugRequest[]>("requests"), request<DebugPrompt[]>("prompts"), request<DebugMemory>("memory"),
  ]);
  return { requests, prompts, memory };
}

export async function clearDebugRequests(): Promise<void> {
  await request<{ cleared: number }>("requests", { method: "DELETE" });
}

