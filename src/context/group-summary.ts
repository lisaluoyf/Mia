import { z } from "zod";
import type { Logger } from "pino";

import type { APIMasterClient, StructuredMessage } from "../clients/apimaster.js";
import type { ChatCredentialProvider } from "../credentials/chat.js";
import type { DebugRecorder } from "../debug/recorder.js";
import {
  GROUP_SUMMARY_SYSTEM_PROMPT,
  groupSummaryInputPrompt,
  promptReference,
} from "../prompts.js";
import type { ContextStore } from "../storage/store.js";
import type { ConversationScope, MemoryRecord, StoredMessage } from "../storage/types.js";
import { estimateStoredMessageTokens } from "./conversation.js";

export const GROUP_SUMMARY_MAX_MESSAGES = 300;
export const GROUP_SUMMARY_MAX_INPUT_TOKENS = 24_000;

const memoryCategorySchema = z.enum(["rule", "role", "project", "preference", "decision", "process"]);
const evidenceTextSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  source_message_ids: z.array(z.number().int().positive()).min(1).max(100),
}).strict();
const topicSchema = z.object({
  title: z.string().trim().min(1).max(300),
  detail: z.string().trim().min(1).max(3000),
  source_message_ids: z.array(z.number().int().positive()).min(1).max(100),
}).strict();
const participantSchema = z.object({
  telegram_user_id: z.number().int().positive(),
  name: z.string().trim().min(1).max(300),
  contribution: z.string().trim().min(1).max(2000),
  source_message_ids: z.array(z.number().int().positive()).min(1).max(100),
}).strict();
const memorySchema = z.object({
  category: memoryCategorySchema,
  content: z.string().trim().min(1).max(1000),
  source_message_id: z.number().int().positive(),
}).strict();

const groupSummaryResultSchema = z.object({
  title: evidenceTextSchema,
  overview: evidenceTextSchema,
  topics: z.array(topicSchema).max(3),
  decisions: z.array(evidenceTextSchema).max(3),
  todos: z.array(evidenceTextSchema).max(3),
  open_questions: z.array(evidenceTextSchema).max(3),
  participants: z.array(participantSchema).max(3),
  historical_context: z.array(evidenceTextSchema).max(2),
  rolling_summary: z.string().trim().max(12_000),
  memories: z.array(memorySchema).max(100),
}).strict();

const evidenceTextJsonSchema = {
  type: "object", additionalProperties: false, required: ["text", "source_message_ids"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: 2000 },
    source_message_ids: { type: "array", minItems: 1, maxItems: 100, items: { type: "integer", minimum: 1 } },
  },
} as const;

const GROUP_SUMMARY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title", "overview", "topics", "decisions", "todos", "open_questions", "participants",
    "historical_context", "rolling_summary", "memories",
  ],
  properties: {
    title: evidenceTextJsonSchema,
    overview: evidenceTextJsonSchema,
    topics: { type: "array", maxItems: 3, items: {
      type: "object", additionalProperties: false, required: ["title", "detail", "source_message_ids"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 300 },
        detail: { type: "string", minLength: 1, maxLength: 3000 },
        source_message_ids: evidenceTextJsonSchema.properties.source_message_ids,
      },
    } },
    decisions: { type: "array", maxItems: 3, items: evidenceTextJsonSchema },
    todos: { type: "array", maxItems: 3, items: evidenceTextJsonSchema },
    open_questions: { type: "array", maxItems: 3, items: evidenceTextJsonSchema },
    participants: { type: "array", maxItems: 3, items: {
      type: "object", additionalProperties: false,
      required: ["telegram_user_id", "name", "contribution", "source_message_ids"],
      properties: {
        telegram_user_id: { type: "integer", minimum: 1 },
        name: { type: "string", minLength: 1, maxLength: 300 },
        contribution: { type: "string", minLength: 1, maxLength: 2000 },
        source_message_ids: evidenceTextJsonSchema.properties.source_message_ids,
      },
    } },
    historical_context: { type: "array", maxItems: 2, items: evidenceTextJsonSchema },
    rolling_summary: { type: "string", maxLength: 12000 },
    memories: { type: "array", maxItems: 100, items: {
      type: "object", additionalProperties: false, required: ["category", "content", "source_message_id"],
      properties: {
        category: { type: "string", enum: memoryCategorySchema.options },
        content: { type: "string", minLength: 1, maxLength: 1000 },
        source_message_id: { type: "integer", minimum: 1 },
      },
    } },
  },
} as const;

const SENSITIVE_VALUE = /(?:sk-[A-Za-z0-9_-]{12,}|\b\d{6,12}:[A-Za-z0-9_-]{20,}|(?:api[ _-]?key|token|password|密码|密钥)\s*[=:：]\s*\S{8,})/i;
const SENSITIVE_VALUE_GLOBAL = /(?:sk-[A-Za-z0-9_-]{12,}|\b\d{6,12}:[A-Za-z0-9_-]{20,}|(?:api[ _-]?key|token|password|密码|密钥)\s*[=:：]\s*\S{8,})/gi;

export type GroupSummaryScope = Extract<ConversationScope, { type: "group" | "topic" }>;
export interface GroupSummaryEvidenceText { text: string; sourceMessageIds: number[] }
export interface GroupSummaryTopic { title: string; detail: string; sourceMessageIds: number[] }
export interface GroupSummaryParticipant {
  telegramUserId: number;
  name: string;
  contribution: string;
  sourceMessageIds: number[];
}
export interface GroupSummaryContent {
  title: GroupSummaryEvidenceText | null;
  overview: GroupSummaryEvidenceText | null;
  topics: GroupSummaryTopic[];
  decisions: GroupSummaryEvidenceText[];
  todos: GroupSummaryEvidenceText[];
  openQuestions: GroupSummaryEvidenceText[];
  participants: GroupSummaryParticipant[];
  historicalContext: GroupSummaryEvidenceText[];
}

interface PersistenceCandidate {
  expectedThroughMessageId: number | null;
  fromMessageId: number;
  summary: string;
  memories: Array<{
    category: string;
    content: string;
    sourceMessageId: number;
    createdByUserId: number | null;
  }>;
}

export interface PreparedGroupSummary {
  content: GroupSummaryContent;
  scope: GroupSummaryScope;
  messageCount: number;
  fromMessageId: number;
  throughMessageId: number;
  currentMessageId: number;
  truncated: boolean;
  debugId: string | null;
  persistence: PersistenceCandidate | null;
  debugDetails: Record<string, unknown>;
}

interface GroupSummaryDependencies {
  client: Pick<APIMasterClient, "resolveAPIKey" | "structuredChat">;
  credentials?: ChatCredentialProvider;
  store: Pick<ContextStore,
    "applyGroupCompaction" | "countMessagesAfterBefore" | "getChat" | "getLatestSummary" |
    "getMessage" | "getUser" | "listMemories" | "listMessagesBetween" | "listRecentMessagesAfterBefore">;
  logger: Logger;
  model: string;
  debug?: DebugRecorder;
}

function redact(value: string): string {
  return value.replace(SENSITIVE_VALUE_GLOBAL, "[敏感信息已省略]");
}

function memoryPreview(memory: MemoryRecord) {
  return {
    category: memory.category,
    content: redact(memory.content),
    source_message_id: memory.sourceMessageId,
  };
}

function formatDialogue(messages: readonly StoredMessage[], store: GroupSummaryDependencies["store"]): string {
  return messages.map((message) => {
    const user = message.senderUserId === null ? null : store.getUser(message.senderUserId);
    const name = user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : null;
    const sender = message.senderUserId === null
      ? `sender_chat_id=${message.senderChatId ?? "unknown"}`
      : `sender_user_id=${message.senderUserId}${name ? ` sender=${JSON.stringify(name)}` : ""}`;
    const reply = message.replyToMessageId === null ? "" : ` reply_to=${message.replyToMessageId}`;
    return `[message_id=${message.messageId} ${sender}${reply} sent_at=${message.sentAt}]\n${redact(
      message.text ?? message.caption ?? `[${message.contentType}]`,
    )}`;
  }).join("\n\n");
}

function selectRecentWithinTokenBudget(messages: readonly StoredMessage[]): StoredMessage[] {
  const selected: StoredMessage[] = [];
  let tokens = 0;
  for (const message of [...messages].reverse()) {
    const next = estimateStoredMessageTokens(message);
    if (selected.length > 0 && tokens + next > GROUP_SUMMARY_MAX_INPUT_TOKENS) break;
    selected.push(message);
    tokens += next;
  }
  return selected.reverse();
}

function belongsToScope(message: StoredMessage, scope: GroupSummaryScope): boolean {
  return message.chatId === scope.chatId &&
    (scope.type === "topic" ? message.threadId === scope.threadId : message.threadId === null);
}

function validatedIds(ids: readonly number[], allowed: ReadonlySet<number>): number[] | null {
  const unique = [...new Set(ids)];
  return unique.length > 0 && unique.every((id) => allowed.has(id)) ? unique : null;
}

export class GroupSummaryService {
  constructor(private readonly dependencies: GroupSummaryDependencies) {}

  get model(): string {
    return this.dependencies.model;
  }

  async summarize(input: {
    scope: GroupSummaryScope;
    requesterUserId: number;
    currentMessageId: number;
    locale: string;
  }): Promise<PreparedGroupSummary | null> {
    const previousSummary = this.dependencies.store.getLatestSummary(input.scope);
    const watermark = previousSummary?.throughMessageId ?? null;
    const pendingCount = this.dependencies.store.countMessagesAfterBefore(
      input.scope,
      watermark,
      input.currentMessageId,
    );
    if (pendingCount === 0) return null;
    const recent = this.dependencies.store.listRecentMessagesAfterBefore(
      input.scope,
      watermark,
      input.currentMessageId,
      GROUP_SUMMARY_MAX_MESSAGES,
    );
    const messages = selectRecentWithinTokenBudget(recent);
    const first = messages[0];
    const last = messages.at(-1);
    if (!first || !last) return null;
    const truncated = pendingCount > messages.length;
    const memories = this.dependencies.store.listMemories(input.scope, 100);
    const inheritedMemories = input.scope.type === "topic"
      ? this.dependencies.store.listMemories({ type: "group", chatId: input.scope.chatId }, 100)
      : [];
    const chat = this.dependencies.store.getChat(input.scope.chatId);
    const scopeMetadata = {
      type: input.scope.type,
      chat_id: input.scope.chatId,
      thread_id: input.scope.type === "topic" ? input.scope.threadId : null,
      chat_title: chat?.title ?? null,
    };
    const dialogue = formatDialogue(messages, this.dependencies.store);
    const prompt: StructuredMessage[] = [
      { role: "system", content: GROUP_SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: groupSummaryInputPrompt({
        scope: scopeMetadata,
        locale: input.locale,
        memories: memories.map(memoryPreview),
        inheritedMemories: inheritedMemories.map(memoryPreview),
        summary: previousSummary ? {
          content: redact(previousSummary.content),
          from_message_id: previousSummary.fromMessageId,
          through_message_id: previousSummary.throughMessageId,
        } : null,
        dialogue,
      }) },
    ];
    const credential = this.dependencies.credentials
      ? await this.dependencies.credentials.resolve(input.requesterUserId, this.dependencies.model)
      : {
          apiKey: await this.dependencies.client.resolveAPIKey(input.requesterUserId, this.dependencies.model),
          model: this.dependencies.model,
          source: "user" as const,
          fallbackReason: null,
        };
    const baseDetails = {
      scope: scopeMetadata,
      selectedFromMessageId: first.messageId,
      selectedThroughMessageId: last.messageId,
      selectedMessageCount: messages.length,
      pendingMessageCount: pendingCount,
      truncated,
      credentialSource: credential.source,
      credentialFallbackReason: credential.fallbackReason,
    };
    const debugId = this.dependencies.debug?.start({
      telegramUserId: input.requesterUserId,
      chatId: input.scope.chatId,
      chatType: chat?.type ?? "group",
      messageId: input.currentMessageId,
      kind: "group_summary",
      model: credential.model,
      promptRefs: [promptReference("mia.group-summary"), promptReference("mia.group-summary-input")],
      contextLayers: {
        systemRules: promptReference("mia.group-summary"),
        conversation: scopeMetadata,
        longTermMemory: {
          currentScope: memories.map(memoryPreview),
          inheritedGroup: inheritedMemories.map(memoryPreview),
        },
        rollingSummary: previousSummary?.content ?? null,
        recentMessages: { order: "oldest_to_newest", count: messages.length, dialogue },
      },
      requestPreview: prompt,
      details: baseDetails,
    }) ?? null;

    try {
      const raw = await this.dependencies.client.structuredChat(
        credential.apiKey,
        credential.model,
        prompt,
        "mia_group_summary",
        GROUP_SUMMARY_JSON_SCHEMA,
      );
      const parsed = groupSummaryResultSchema.parse(raw);
      const selectedById = new Map(messages.map((message) => [message.messageId, message]));
      const selectedIds = new Set(selectedById.keys());
      const historicalIds = new Set(selectedIds);
      for (const memory of memories) {
        if (memory.sourceMessageId === null) continue;
        const source = this.dependencies.store.getMessage(input.scope.chatId, memory.sourceMessageId);
        if (source && belongsToScope(source, input.scope)) historicalIds.add(memory.sourceMessageId);
      }
      for (const memory of inheritedMemories) {
        if (memory.sourceMessageId === null) continue;
        const source = this.dependencies.store.getMessage(input.scope.chatId, memory.sourceMessageId);
        if (source?.threadId === null) historicalIds.add(memory.sourceMessageId);
      }
      let droppedEvidenceCount = 0;
      let validEvidenceCount = 0;
      const evidence = (item: z.infer<typeof evidenceTextSchema>, allowed = selectedIds): GroupSummaryEvidenceText | null => {
        const ids = validatedIds(item.source_message_ids, allowed);
        if (!ids) {
          droppedEvidenceCount += 1;
          return null;
        }
        validEvidenceCount += 1;
        return { text: redact(item.text), sourceMessageIds: ids };
      };
      const evidenceList = (items: Array<z.infer<typeof evidenceTextSchema>>, allowed = selectedIds) =>
        items.flatMap((item) => {
          const valid = evidence(item, allowed);
          return valid ? [valid] : [];
        });
      const topics = parsed.topics.flatMap((topic) => {
        const ids = validatedIds(topic.source_message_ids, selectedIds);
        if (!ids) {
          droppedEvidenceCount += 1;
          return [];
        }
        validEvidenceCount += 1;
        return [{ title: redact(topic.title), detail: redact(topic.detail), sourceMessageIds: ids }];
      });
      const participants = parsed.participants.flatMap((participant) => {
        const ids = validatedIds(participant.source_message_ids, selectedIds);
        const correctlyAttributed = ids?.every((id) => selectedById.get(id)?.senderUserId === participant.telegram_user_id);
        if (!ids || !correctlyAttributed) {
          droppedEvidenceCount += 1;
          return [];
        }
        validEvidenceCount += 1;
        return [{
          telegramUserId: participant.telegram_user_id,
          name: redact(participant.name),
          contribution: redact(participant.contribution),
          sourceMessageIds: ids,
        }];
      });
      const allowedMemoryIds = new Set(selectedIds);
      for (const memory of memories) if (memory.sourceMessageId !== null) allowedMemoryIds.add(memory.sourceMessageId);
      const seenMemories = new Set<string>();
      const safeMemories = parsed.memories.flatMap((memory) => {
        const normalized = `${memory.category}:${memory.content.toLocaleLowerCase().replace(/\s+/g, " ").trim()}`;
        const source = this.dependencies.store.getMessage(input.scope.chatId, memory.source_message_id);
        if (SENSITIVE_VALUE.test(memory.content) || seenMemories.has(normalized) ||
            !allowedMemoryIds.has(memory.source_message_id) || !source || !belongsToScope(source, input.scope)) return [];
        seenMemories.add(normalized);
        return [{
          category: memory.category,
          content: redact(memory.content),
          sourceMessageId: memory.source_message_id,
          createdByUserId: source.senderUserId,
        }];
      });
      const content: GroupSummaryContent = {
        title: evidence(parsed.title),
        overview: evidence(parsed.overview),
        topics,
        decisions: evidenceList(parsed.decisions),
        todos: evidenceList(parsed.todos),
        openQuestions: evidenceList(parsed.open_questions),
        participants,
        historicalContext: evidenceList(parsed.historical_context, historicalIds),
      };
      const persistence = truncated ? null : {
        expectedThroughMessageId: watermark,
        fromMessageId: previousSummary?.fromMessageId ?? first.messageId,
        summary: redact(parsed.rolling_summary),
        memories: safeMemories,
      };
      return {
        content,
        scope: input.scope,
        messageCount: messages.length,
        fromMessageId: first.messageId,
        throughMessageId: last.messageId,
        currentMessageId: input.currentMessageId,
        truncated,
        debugId,
        persistence,
        debugDetails: { ...baseDetails, validEvidenceCount, droppedEvidenceCount },
      };
    } catch (error) {
      this.dependencies.debug?.finish(debugId, {
        status: "failed",
        errorCode: error instanceof Error ? error.name.slice(0, 80) : "unknown_error",
        details: { ...baseDetails, failureReason: "model_or_validation_failed" },
      });
      throw error;
    }
  }

  complete(
    prepared: PreparedGroupSummary,
    lastAssistantMessageId: number,
    summaryMessageIds: readonly number[],
  ): boolean {
    let persisted = false;
    let persistenceSkipped: string | null = prepared.truncated ? "truncated_backlog" : null;
    if (prepared.persistence) {
      try {
        const coveredIds = new Set([prepared.currentMessageId, ...summaryMessageIds]);
        const intervening = this.dependencies.store.listMessagesBetween(
          prepared.scope,
          prepared.throughMessageId + 1,
          lastAssistantMessageId,
        );
        if (intervening.some((message) => !coveredIds.has(message.messageId))) {
          persistenceSkipped = "concurrent_messages";
        } else {
          this.dependencies.store.applyGroupCompaction({
            scope: prepared.scope,
            expectedThroughMessageId: prepared.persistence.expectedThroughMessageId,
            summary: prepared.persistence.summary,
            fromMessageId: prepared.persistence.fromMessageId,
            throughMessageId: lastAssistantMessageId,
            memories: prepared.persistence.memories,
          });
          persisted = true;
        }
      } catch (error) {
        persistenceSkipped = error instanceof Error && error.message === "Group compaction watermark changed"
          ? "watermark_changed"
          : "persistence_failed";
        this.dependencies.logger.warn({ err: error, scope: prepared.scope }, "Mia group summary persistence failed");
      }
    }
    this.dependencies.debug?.finish(prepared.debugId, {
      status: "succeeded",
      responsePreview: prepared.content,
      details: {
        ...prepared.debugDetails,
        rollingSummaryWritten: persisted,
        memoriesWritten: persisted ? prepared.persistence?.memories.length ?? 0 : 0,
        persistenceSkipped,
        finalWatermark: persisted ? lastAssistantMessageId : null,
      },
    });
    return persisted;
  }

  failDelivery(prepared: PreparedGroupSummary): void {
    this.dependencies.debug?.finish(prepared.debugId, {
      status: "failed",
      errorCode: "telegram_delivery_failed",
      details: { ...prepared.debugDetails, failureReason: "telegram_delivery_failed", rollingSummaryWritten: false },
    });
  }
}
