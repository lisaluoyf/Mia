import type { MediaBinary, StructuredMessage } from "../clients/apimaster.js";
import type { MediaInput } from "../media/types.js";
import type { ContextStore } from "../storage/store.js";
import type { ConversationScope, MemoryRecord, StoredMessage, UserProfile } from "../storage/types.js";

export const CONTEXT_TURN_BATCH_SIZE = 10;
const MAX_CONTEXT_MESSAGES = 100;
export const GROUP_CONTEXT_TAIL_MESSAGES = 100;
export const GROUP_CONTEXT_SPEAKER_MESSAGES = 8;
export const GROUP_CONTEXT_TOKEN_BUDGET = 16_000;
const MAX_CONTEXT_IMAGES = 10;
const GROUP_MEDIA_WINDOW_MS = 30 * 60 * 1_000;

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
  participants: UserProfile[];
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
    "listRecentMessagesBySender" | "getMessage" | "getReplyChain" | "getUser" | "listPendingCompletedTurns">;
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

export function estimateStoredMessageTokens(message: StoredMessage): number {
  const content = message.text ?? message.caption ?? `[${message.contentType}]`;
  const cjk = content.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const other = Math.max(0, Array.from(content).length - cjk);
  return 16 + cjk + Math.ceil(other / 4);
}

function belongsToScope(message: StoredMessage, scope: ConversationScope): boolean {
  if (message.chatId !== scope.chatId) return false;
  return scope.type === "topic" ? message.threadId === scope.threadId : message.threadId === null;
}

function takeGroupContext(
  messages: readonly StoredMessage[],
  speakerMessages: readonly StoredMessage[],
  replyChain: readonly StoredMessage[],
  currentMessageId: number,
): StoredMessage[] {
  const ordered = [...messages].sort((left, right) => left.messageId - right.messageId);
  const current = ordered.find((message) => message.messageId === currentMessageId);
  const selected = new Map<number, StoredMessage>();
  let tokenCount = 0;

  const add = (message: StoredMessage): void => {
    if (selected.has(message.messageId)) return;
    const tokens = estimateStoredMessageTokens(message);
    if (tokenCount + tokens > GROUP_CONTEXT_TOKEN_BUDGET) return;
    selected.set(message.messageId, message);
    tokenCount += tokens;
  };

  if (current) add(current);
  for (const message of [...replyChain].reverse()) add(message);

  const newestFirst = [...messages].sort((left, right) => right.messageId - left.messageId);
  [...speakerMessages].sort((left, right) => right.messageId - left.messageId)
    .slice(0, GROUP_CONTEXT_SPEAKER_MESSAGES).forEach((message) => add(message));
  newestFirst.slice(0, GROUP_CONTEXT_TAIL_MESSAGES).forEach((message) => add(message));

  return [...selected.values()].sort((left, right) => left.messageId - right.messageId);
}

function memoriesForScope(input: LoadContextInput): MemoryRecord[] {
  if (input.scope.type === "private") {
    return input.store.listMemories({ type: "user", userId: input.userId }, 100);
  }
  if (input.scope.type === "group") {
    return input.store.listMemories(input.scope, 100);
  }
  return [
    ...input.store.listMemories({ type: "group", chatId: input.scope.chatId }, 100),
    ...input.store.listMemories(input.scope, 100),
  ];
}

export function loadConversationContext(input: LoadContextInput, botUserId: number): ConversationContext {
  const latestSummary = input.store.getLatestSummary(input.scope);
  const pendingTurns = input.scope.type === "private"
    ? input.store.listPendingCompletedTurns(input.scope.chatId, 100)
    : [];
  let messages: StoredMessage[];
  if (input.scope.type === "private") {
    const available = latestSummary
      ? input.store.listMessagesAfter(input.scope, latestSummary.throughMessageId, MAX_CONTEXT_MESSAGES)
      : pendingTurns[0]
        ? input.store.listMessagesAfter(
          input.scope,
          pendingTurns[0].userMessageId > 1 ? pendingTurns[0].userMessageId - 1 : null,
          MAX_CONTEXT_MESSAGES,
        )
        : input.store.listRecentMessages(input.scope, MAX_CONTEXT_MESSAGES);
    messages = latestSummary || pendingTurns.length > 0 ? available : takeLastTurns(available, botUserId);
  } else {
    const recent = input.store.listRecentMessages(input.scope, GROUP_CONTEXT_TAIL_MESSAGES);
    const speakerMessages = input.store.listRecentMessagesBySender(
      input.scope,
      input.userId,
      GROUP_CONTEXT_SPEAKER_MESSAGES,
    );
    const available = [...recent];
    const current = input.store.getMessage(input.scope.chatId, input.currentMessageId);
    if (current && belongsToScope(current, input.scope) && !available.some((message) => message.messageId === current.messageId)) {
      available.push(current);
    }
    const replyChain = input.replyToMessageId === null
      ? []
      : input.store.getReplyChain(input.scope.chatId, input.replyToMessageId)
        .filter((message) => belongsToScope(message, input.scope));
    messages = takeGroupContext(available, speakerMessages, replyChain, input.currentMessageId);
  }
  const includedIds = new Set(messages.map((message) => message.messageId));

  for (const referencedId of [input.replyToMessageId, input.activeMedia?.messageId ?? null]) {
    if (referencedId === null || includedIds.has(referencedId)) continue;
    const referenced = input.store.getMessage(input.scope.chatId, referencedId);
    if (referenced && belongsToScope(referenced, input.scope)) {
      messages.unshift(referenced);
      includedIds.add(referencedId);
    }
  }
  messages.sort((left, right) => left.messageId - right.messageId);

  const mediaInputs: MediaInput[] = [];
  const mediaIds = new Set<string>();
  const currentTime = Date.parse(input.metadata.currentTime) ||
    Date.parse(messages.find((message) => message.messageId === input.currentMessageId)?.sentAt ?? "") || Date.now();
  for (const message of messages) {
    if (!message.mediaFileId || (message.contentType !== "photo" && message.contentType !== "document")) continue;
    const isExplicitMedia = message.messageId === input.currentMessageId || message.messageId === input.replyToMessageId;
    const ageMs = currentTime - Date.parse(message.sentAt);
    if (input.scope.type !== "private" && !isExplicitMedia &&
        (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > GROUP_MEDIA_WINDOW_MS)) continue;
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
        : messageId === input.activeMedia?.messageId ? 2
          : messages.find((message) => message.messageId === messageId)?.senderUserId === input.userId ? 3 : 4;
    const difference = rank(left.messageId) - rank(right.messageId);
    return difference === 0 ? right.messageId - left.messageId : difference;
  }).slice(0, MAX_CONTEXT_IMAGES).map((media, position) => ({ ...media, position }));

  const participantIds = [...new Set(messages.flatMap((message) => message.senderUserId === null ? [] : [message.senderUserId]))];
  const participants = participantIds.flatMap((userId) => {
    const user = input.store.getUser(userId);
    return user ? [user] : [];
  });

  return {
    metadata: input.metadata,
    participants,
    memories: memoriesForScope(input),
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
  images: readonly (MediaBinary | undefined)[],
  botUserId: number,
): StructuredMessage[] {
  const imageByMessage = new Map<number, MediaBinary>();
  const mediaByMessage = new Map(context.mediaInputs.map((input) => [input.messageId, input]));
  context.mediaInputs.forEach((input, index) => {
    const image = images[index];
    if (image) imageByMessage.set(input.messageId, image);
  });
  const layerData = {
    current_conversation: context.metadata,
    participants: context.participants.map((participant) => ({
      telegram_user_id: participant.telegramUserId,
      display_name: [participant.firstName, participant.lastName].filter(Boolean).join(" "),
      username: participant.username,
    })),
    long_term_memory: context.memories.map((memory) => ({
      scope: memory.scope.type,
      category: memory.category,
      content: memory.content,
      source_message_id: memory.sourceMessageId,
    })),
    earlier_conversation_summary: context.summary,
    message_order: "oldest_to_newest",
    current_message_priority: "highest",
    media_priority: ["current", "replied", "active", "historical"],
  };
  const result: StructuredMessage[] = [{ role: "system", content: JSON.stringify(layerData) }];
  let turn = 0;
  for (const message of context.messages) {
    const role = message.senderUserId === botUserId ? "assistant" : "user";
    const participant = context.participants.find((item) => item.telegramUserId === message.senderUserId);
    const senderName = participant ? [participant.firstName, participant.lastName].filter(Boolean).join(" ") : null;
    if (role === "user") turn += 1;
    const isCurrent = message.messageId === context.currentMessageId;
    const label = `[第 ${Math.max(turn, 1)} 轮${isCurrent ? "，当前消息" : ""} | message_id=${message.messageId}` +
      `${message.senderUserId === null ? "" : ` | sender_user_id=${message.senderUserId}`}` +
      `${senderName ? ` | sender=${JSON.stringify(senderName)}` : ""}` +
      `${message.replyToMessageId === null ? "" : ` | reply_to=${message.replyToMessageId}`}]`;
    const text = `${label}\n${message.text ?? message.caption ?? `[${message.contentType}]`}`;
    const media = mediaByMessage.get(message.messageId);
    const image = imageByMessage.get(message.messageId);
    const imageId = `image_turn_${Math.max(turn, 1)}_1`;
    const mediaLabel = media
      ? `[image id=${imageId} message_id=${message.messageId} turn=${Math.max(turn, 1)} ` +
        `status=${mediaStatus(context, message.messageId)} pixels=${image ? "provided" : "not_provided"}]`
      : null;
    if (!image || role === "assistant") {
      result.push({ role, content: mediaLabel ? `${text}\n${mediaLabel}` : text });
      continue;
    }
    result.push({
      role,
      content: [
        { type: "text", text },
        { type: "text", text: mediaLabel ?? `[image id=${imageId}]` },
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
