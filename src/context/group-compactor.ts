import { z } from "zod";
import type { Logger } from "pino";

import type { APIMasterClient, StructuredMessage } from "../clients/apimaster.js";
import type { ChatCredentialProvider } from "../credentials/chat.js";
import type { DebugRecorder } from "../debug/recorder.js";
import { debugFailureCode, debugFailureDetails } from "../debug/error.js";
import {
  groupContextCompactionInputPrompt,
  promptReference,
  promptTemplate,
} from "../prompts.js";
import type { ContextStore } from "../storage/store.js";
import type { ConversationScope, MemoryRecord, StoredMessage } from "../storage/types.js";
import { estimateStoredMessageTokens } from "./conversation.js";

export const GROUP_COMPACTION_MESSAGE_THRESHOLD = 50;
export const GROUP_COMPACTION_TOKEN_THRESHOLD = 12_000;
const GROUP_COMPACTION_READ_LIMIT = 500;
const GROUP_COMPACTION_MAX_MESSAGES = 120;
const GROUP_COMPACTION_MAX_INPUT_TOKENS = 16_000;

const groupCompactionResultSchema = z.object({
  memories: z.array(z.object({
    category: z.enum(["rule", "role", "project", "preference", "decision", "process"]),
    content: z.string().trim().min(1).max(1000),
    source_message_id: z.number().int().positive(),
  }).strict()).max(100),
  summary: z.string().trim().max(8000),
}).strict();

const GROUP_COMPACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["memories", "summary"],
  properties: {
    memories: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "content", "source_message_id"],
        properties: {
          category: { type: "string", enum: ["rule", "role", "project", "preference", "decision", "process"] },
          content: { type: "string", minLength: 1, maxLength: 1000 },
          source_message_id: { type: "integer", minimum: 1 },
        },
      },
    },
    summary: { type: "string", maxLength: 8000 },
  },
} as const;

const SENSITIVE_VALUE = /(?:sk-[A-Za-z0-9_-]{12,}|\b\d{6,12}:[A-Za-z0-9_-]{20,}|(?:api[ _-]?key|token|password|密码|密钥)\s*[=:：]\s*\S{8,})/i;
const SENSITIVE_VALUE_GLOBAL = /(?:sk-[A-Za-z0-9_-]{12,}|\b\d{6,12}:[A-Za-z0-9_-]{20,}|(?:api[ _-]?key|token|password|密码|密钥)\s*[=:：]\s*\S{8,})/gi;

type GroupScope = Extract<ConversationScope, { type: "group" | "topic" }>;

interface GroupCompactorDependencies {
  client: Pick<APIMasterClient, "resolveAPIKey" | "structuredChat">;
  credentials?: ChatCredentialProvider;
  store: Pick<ContextStore,
    "getChat" | "getLatestSummary" | "getMessage" | "getUser" | "listMemories" |
    "listMessagesAfter" | "applyGroupCompaction">;
  logger: Logger;
  model: string | (() => string);
  debug?: DebugRecorder;
}

function scopeKey(scope: GroupScope): string {
  return scope.type === "topic" ? `${scope.chatId}:${scope.threadId}` : `${scope.chatId}:0`;
}

function selectBatch(messages: readonly StoredMessage[]): StoredMessage[] {
  const selected: StoredMessage[] = [];
  let tokens = 0;
  for (const message of messages) {
    const nextTokens = estimateStoredMessageTokens(message);
    if (selected.length >= GROUP_COMPACTION_MAX_MESSAGES ||
        selected.length > 0 && tokens + nextTokens > GROUP_COMPACTION_MAX_INPUT_TOKENS) break;
    selected.push(message);
    tokens += nextTokens;
  }
  return selected;
}

function thresholdReached(messages: readonly StoredMessage[]): boolean {
  if (messages.length >= GROUP_COMPACTION_MESSAGE_THRESHOLD) return true;
  return messages.reduce((total, message) => total + estimateStoredMessageTokens(message), 0) >=
    GROUP_COMPACTION_TOKEN_THRESHOLD;
}

function formatDialogue(messages: readonly StoredMessage[], store: GroupCompactorDependencies["store"]): string {
  return messages.map((message) => {
    const user = message.senderUserId === null ? null : store.getUser(message.senderUserId);
    const displayName = user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : null;
    const sender = message.senderUserId === null
      ? `sender_chat_id=${message.senderChatId ?? "unknown"}`
      : `sender_user_id=${message.senderUserId}${displayName ? ` sender=${JSON.stringify(displayName)}` : ""}`;
    const reply = message.replyToMessageId === null ? "" : ` reply_to=${message.replyToMessageId}`;
    return `[message_id=${message.messageId} ${sender}${reply} sent_at=${message.sentAt}]\n` +
      (message.text ?? message.caption ?? `[${message.contentType}]`);
  }).join("\n\n");
}

function memoryPreview(memory: MemoryRecord) {
  return {
    category: memory.category,
    content: memory.content,
    source_message_id: memory.sourceMessageId,
  };
}

export class GroupContextCompactor {
  private readonly running = new Set<string>();

  constructor(private readonly dependencies: GroupCompactorDependencies) {}

  recordSuccessfulGroupTrigger(scope: GroupScope, payerUserId: number): void {
    void this.compact(scope, payerUserId);
  }

  private async compact(scope: GroupScope, payerUserId: number): Promise<void> {
    const key = scopeKey(scope);
    if (this.running.has(key)) return;
    this.running.add(key);
    let debugId: string | null = null;
    try {
      while (true) {
        const previousSummary = this.dependencies.store.getLatestSummary(scope);
        const pending = this.dependencies.store.listMessagesAfter(
          scope,
          previousSummary?.throughMessageId ?? null,
          GROUP_COMPACTION_READ_LIMIT,
        );
        if (!thresholdReached(pending)) return;
        const messages = selectBatch(pending);
        const first = messages[0];
        const last = messages.at(-1);
        if (!first || !last) return;
        const memories = this.dependencies.store.listMemories(scope, 100);
        const chat = this.dependencies.store.getChat(scope.chatId);
        const locale = this.dependencies.store.getUser(payerUserId)?.languageCode ?? null;
        const scopeMetadata = {
          type: scope.type,
          chat_id: scope.chatId,
          thread_id: scope.type === "topic" ? scope.threadId : null,
          chat_title: chat?.title ?? null,
        };
        const dialogue = formatDialogue(messages, this.dependencies.store);
        const prompt: StructuredMessage[] = [
          { role: "system", content: promptTemplate("mia.group-context-compaction", locale, {}) },
          {
            role: "user",
            content: groupContextCompactionInputPrompt({
              scope: scopeMetadata,
              memories: memories.map(memoryPreview),
              summary: previousSummary?.content ?? null,
              dialogue,
            }, locale),
          },
        ];
        const configuredModel = typeof this.dependencies.model === "function"
          ? this.dependencies.model()
          : this.dependencies.model;
        const credential = this.dependencies.credentials
          ? await this.dependencies.credentials.resolve(payerUserId, configuredModel)
          : {
              apiKey: await this.dependencies.client.resolveAPIKey(payerUserId, configuredModel),
              model: configuredModel,
              source: "user" as const,
              fallbackReason: null,
            };
        debugId = this.dependencies.debug?.start({
          telegramUserId: payerUserId,
          chatId: scope.chatId,
          chatType: chat?.type ?? "group",
          messageId: last.messageId,
          kind: "group_compaction",
          model: credential.model,
          promptRefs: [
            promptReference("mia.group-context-compaction"),
            promptReference("mia.group-context-compaction-input"),
          ],
          contextLayers: {
            systemRules: promptReference("mia.group-context-compaction"),
            conversation: scopeMetadata,
            longTermMemory: memories.map(memoryPreview),
            rollingSummary: previousSummary?.content ?? null,
            recentMessages: { order: "oldest_to_newest", dialogue },
          },
          requestPreview: prompt,
          details: {
            fromMessageId: first.messageId,
            throughMessageId: last.messageId,
            credentialSource: credential.source,
            credentialFallbackReason: credential.fallbackReason,
          },
        }) ?? null;
        const raw = await this.dependencies.client.structuredChat(
          credential.apiKey,
          credential.model,
          prompt,
          "mia_group_context_compaction",
          GROUP_COMPACTION_JSON_SCHEMA,
        );
        const parsed = groupCompactionResultSchema.parse(raw);
        const safeSummary = parsed.summary.replace(SENSITIVE_VALUE_GLOBAL, "[敏感信息已省略]");
        const allowedSources = new Set([
          ...messages.map((message) => message.messageId),
          ...memories.flatMap((memory) => memory.sourceMessageId === null ? [] : [memory.sourceMessageId]),
        ]);
        const seen = new Set<string>();
        const safeMemories = parsed.memories.flatMap((memory) => {
          const normalized = `${memory.category}:${memory.content.toLocaleLowerCase().replace(/\s+/g, " ").trim()}`;
          if (SENSITIVE_VALUE.test(memory.content) || seen.has(normalized) || !allowedSources.has(memory.source_message_id)) return [];
          const source = this.dependencies.store.getMessage(scope.chatId, memory.source_message_id);
          if (!source || (scope.type === "topic" ? source.threadId !== scope.threadId : source.threadId !== null)) return [];
          seen.add(normalized);
          return [{
            category: memory.category,
            content: memory.content,
            sourceMessageId: memory.source_message_id,
            createdByUserId: source.senderUserId,
          }];
        });
        this.dependencies.store.applyGroupCompaction({
          scope,
          expectedThroughMessageId: previousSummary?.throughMessageId ?? null,
          summary: safeSummary,
          fromMessageId: previousSummary?.fromMessageId ?? first.messageId,
          throughMessageId: last.messageId,
          memories: safeMemories,
        });
        this.dependencies.debug?.finish(debugId, {
          status: "succeeded",
          responsePreview: { memories: safeMemories, summary: safeSummary },
          details: {
            scope: scopeMetadata,
            fromMessageId: first.messageId,
            throughMessageId: last.messageId,
            messageCount: messages.length,
          },
        });
        debugId = null;
        return;
      }
    } catch (error) {
      this.dependencies.debug?.finish(debugId, {
        status: "failed",
        errorCode: debugFailureCode(error),
        details: debugFailureDetails(error),
      });
      this.dependencies.logger.warn({ err: error, scope, payerUserId }, "Mia group context compaction failed");
    } finally {
      this.running.delete(key);
    }
  }
}
