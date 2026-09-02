import type { MediaBinary, StructuredMessage } from "../clients/apimaster.js";
import type { MediaInput } from "../media/types.js";
import type { ContextStore } from "../storage/store.js";
import type { ConversationScope, MemoryRecord, StoredMessage } from "../storage/types.js";

export const CONTEXT_TURN_BATCH_SIZE = 10;
const MAX_CONTEXT_MESSAGES = 100;
const MAX_CONTEXT_IMAGES = 10;

export interface ConversationMetadata {
  chatType: string;
  chatTitle: string | null;
  currentUser: string;
  language: string | null;
  currentTime: string;
  timezone: string | null;
  trigger: string;
  currentTask: string | null;
}

export interface ConversationContext {
  metadata: ConversationMetadata;
  memories: MemoryRecord[];
  summary: string | null;
  messages: StoredMessage[];
  mediaInputs: MediaInput[];
  currentMessageId: number;
  replyToMessageId: number | null;
  activeMediaMessageId: number | null;
}

interface LoadContextInput {
  store: Pick<ContextStore,
    "getLatestSummary" | "listMemories" | "listMessagesAfter" | "listRecentMessages" |
    "getMessage" | "listPendingCompletedTurns">;
  scope: ConversationScope;
  userId: number;
  currentMessageId: number;
  replyToMessageId: number | null;
  activeMedia?: MediaInput | null;
  metadata: ConversationMetadata;
}

function takeLastTurns(messages: readonly StoredMessage[], botUserId: number, limit = CONTEXT_TURN_BATCH_SIZE): StoredMessage[] {
  let userTurns = 0;
  let start = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    start = index;
    if (message.senderUserId !== botUserId) {
      userTurns += 1;
      if (userTurns === limit) break;
    }
  }
  return messages.slice(start);
}

export function loadConversationContext(input: LoadContextInput, botUserId: number): ConversationContext {
  const latestSummary = input.store.getLatestSummary(input.scope);
  const pendingTurns = input.scope.type === "private"
    ? input.store.listPendingCompletedTurns(input.scope.chatId, 100)
    : [];
  const available = latestSummary
    ? input.store.listMessagesAfter(input.scope, latestSummary.throughMessageId, MAX_CONTEXT_MESSAGES)
    : pendingTurns[0]
      ? input.store.listMessagesAfter(
        input.scope,
        pendingTurns[0].userMessageId > 1 ? pendingTurns[0].userMessageId - 1 : null,
        MAX_CONTEXT_MESSAGES,
      )
      : input.store.listRecentMessages(input.scope, MAX_CONTEXT_MESSAGES);
  const messages = latestSummary || pendingTurns.length > 0 ? available : takeLastTurns(available, botUserId);
  const includedIds = new Set(messages.map((message) => message.messageId));

  for (const referencedId of [input.replyToMessageId, input.activeMedia?.messageId ?? null]) {
    if (referencedId === null || includedIds.has(referencedId)) continue;
    const referenced = input.store.getMessage(input.scope.chatId, referencedId);
    if (referenced) {
      messages.unshift(referenced);
      includedIds.add(referencedId);
    }
  }
  messages.sort((left, right) => left.messageId - right.messageId);

  const mediaInputs: MediaInput[] = [];
  const mediaIds = new Set<string>();
  for (const message of messages) {
    if (!message.mediaFileId || (message.contentType !== "photo" && message.contentType !== "document")) continue;
    if (mediaIds.has(message.mediaFileId)) continue;
    mediaIds.add(message.mediaFileId);
    mediaInputs.push({
      position: 0,
      messageId: message.messageId,
      fileId: message.mediaFileId,
      fileUniqueId: message.mediaUniqueId,
      type: message.contentType,
      mimeType: message.contentType === "photo" ? "image/jpeg" : null,
      mediaGroupId: null,
    });
  }
  if (input.activeMedia && !mediaIds.has(input.activeMedia.fileId)) {
    mediaInputs.push({ ...input.activeMedia, position: 0 });
  }

  const prioritized = mediaInputs.sort((left, right) => {
    const rank = (messageId: number): number => messageId === input.currentMessageId ? 0
      : messageId === input.replyToMessageId ? 1
        : messageId === input.activeMedia?.messageId ? 2 : 3;
    const difference = rank(left.messageId) - rank(right.messageId);
    return difference === 0 ? right.messageId - left.messageId : difference;
  }).slice(0, MAX_CONTEXT_IMAGES).map((media, position) => ({ ...media, position }));

  return {
    metadata: input.metadata,
    memories: input.scope.type === "private"
      ? input.store.listMemories({ type: "user", userId: input.userId }, 100)
      : [],
    summary: latestSummary?.content ?? null,
    messages,
    mediaInputs: prioritized,
    currentMessageId: input.currentMessageId,
    replyToMessageId: input.replyToMessageId,
    activeMediaMessageId: input.activeMedia?.messageId ?? null,
  };
}

function mediaStatus(context: ConversationContext, messageId: number): string {
  if (messageId === context.currentMessageId) return "current";
  if (messageId === context.replyToMessageId) return "replied";
  if (messageId === context.activeMediaMessageId) return "active";
  return "historical";
}

export function buildConversationMessages(
  context: ConversationContext,
  images: readonly MediaBinary[],
  botUserId: number,
): StructuredMessage[] {
  const imageByMessage = new Map<number, MediaBinary>();
  context.mediaInputs.forEach((input, index) => {
    const image = images[index];
    if (image) imageByMessage.set(input.messageId, image);
  });
  const layerData = {
    current_conversation: context.metadata,
    long_term_memory: context.memories.map((memory) => ({ category: memory.category, content: memory.content })),
    earlier_conversation_summary: context.summary,
    message_order: "oldest_to_newest",
    current_message_priority: "highest",
    media_priority: ["current", "replied", "active", "historical"],
  };
  const result: StructuredMessage[] = [{ role: "system", content: JSON.stringify(layerData) }];
  let turn = 0;
  for (const message of context.messages) {
    const role = message.senderUserId === botUserId ? "assistant" : "user";
    if (role === "user") turn += 1;
    const isCurrent = message.messageId === context.currentMessageId;
    const label = `[第 ${Math.max(turn, 1)} 轮${isCurrent ? "，当前消息" : ""} | message_id=${message.messageId}` +
      `${message.senderUserId === null ? "" : ` | sender_user_id=${message.senderUserId}`}` +
      `${message.replyToMessageId === null ? "" : ` | reply_to=${message.replyToMessageId}`}]`;
    const text = `${label}\n${message.text ?? message.caption ?? `[${message.contentType}]`}`;
    const image = imageByMessage.get(message.messageId);
    if (!image || role === "assistant") {
      result.push({ role, content: text });
      continue;
    }
    const imageId = `image_turn_${Math.max(turn, 1)}_1`;
    result.push({
      role,
      content: [
        { type: "text", text },
        { type: "text", text: `[image id=${imageId} turn=${Math.max(turn, 1)} status=${mediaStatus(context, message.messageId)}]` },
        { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}` } },
      ],
    });
  }
  return result;
}

export function formatCompactionDialogue(messages: readonly StoredMessage[], userId: number): string {
  let turn = 0;
  return messages.map((message) => {
    const role = message.senderUserId === userId ? "用户" : "Mia";
    if (role === "用户") turn += 1;
    const media = message.mediaFileId ? ` [图片 image_turn_${Math.max(turn, 1)}_1]` : "";
    return `[第 ${Math.max(turn, 1)} 轮 | ${role}]${media}\n${message.text ?? message.caption ?? `[${message.contentType}]`}`;
  }).join("\n\n");
}
