import { z } from "zod";
import type { Logger } from "pino";

import type { APIMasterClient, StructuredMessage } from "../clients/apimaster.js";
import type { ChatCredentialProvider } from "../credentials/chat.js";
import type { DebugRecorder } from "../debug/recorder.js";
import { contextCompactionInputPrompt, promptReference, promptTemplate } from "../prompts.js";
import type { ContextStore } from "../storage/store.js";
import { CONTEXT_TURN_BATCH_SIZE, formatCompactionDialogue } from "./conversation.js";

const compactionResultSchema = z.object({
  memories: z.array(z.object({
    category: z.enum(["identity", "preference", "habit", "goal"]),
    content: z.string().trim().min(1).max(1000),
  }).strict()).max(100),
  summary: z.string().trim().max(6000),
}).strict();

const COMPACTION_JSON_SCHEMA = {
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
        required: ["category", "content"],
        properties: {
          category: { type: "string", enum: ["identity", "preference", "habit", "goal"] },
          content: { type: "string", minLength: 1, maxLength: 1000 },
        },
      },
    },
    summary: { type: "string", maxLength: 6000 },
  },
} as const;

const SENSITIVE_VALUE = /(?:sk-[A-Za-z0-9_-]{12,}|\b\d{6,12}:[A-Za-z0-9_-]{20,}|(?:api[ _-]?key|token|password|密码|密钥)\s*[=:：]\s*\S{8,})/i;

interface CompactorDependencies {
  client: Pick<APIMasterClient, "resolveAPIKey" | "structuredChat">;
  credentials?: ChatCredentialProvider;
  store: Pick<ContextStore,
    "recordCompletedTurn" | "listPendingCompletedTurns" | "listMessagesBetween" |
    "listMemories" | "getLatestSummary" | "applyPrivateCompaction" | "getUser">;
  logger: Logger;
  model: string | (() => string);
  debug?: DebugRecorder;
}

export class ContextCompactor {
  private readonly running = new Set<number>();

  constructor(private readonly dependencies: CompactorDependencies) {}

  recordSuccessfulPrivateTurn(input: {
    chatId: number;
    userId: number;
    userMessageId: number;
    assistantMessageId: number;
  }): void {
    this.dependencies.store.recordCompletedTurn(input);
    void this.compact(input.chatId, input.userId);
  }

  private async compact(chatId: number, userId: number): Promise<void> {
    if (this.running.has(chatId)) return;
    this.running.add(chatId);
    let failed = false;
    let debugId: string | null = null;
    try {
      while (true) {
        const turns = this.dependencies.store.listPendingCompletedTurns(chatId, CONTEXT_TURN_BATCH_SIZE);
        if (turns.length < CONTEXT_TURN_BATCH_SIZE) return;
        const first = turns[0];
        const last = turns.at(-1);
        if (!first || !last || turns.some((turn) => turn.userId !== userId)) return;
        const scope = { type: "private" as const, chatId };
        const messages = this.dependencies.store.listMessagesBetween(
          scope,
          first.userMessageId,
          last.assistantMessageId,
        );
        const memories = this.dependencies.store.listMemories({ type: "user", userId }, 100);
        const previousSummary = this.dependencies.store.getLatestSummary(scope)?.content ?? null;
        const locale = this.dependencies.store.getUser(userId)?.languageCode ?? null;
        const prompt: StructuredMessage[] = [
          { role: "system", content: promptTemplate("mia.context-compaction", locale, {}) },
          {
            role: "user",
            content: contextCompactionInputPrompt({
              memories: memories.map((item) => ({ category: item.category, content: item.content })),
              summary: previousSummary,
              dialogue: formatCompactionDialogue(messages, userId),
            }, locale),
          },
        ];
        const configuredModel = typeof this.dependencies.model === "function"
          ? this.dependencies.model()
          : this.dependencies.model;
        const credential = this.dependencies.credentials
          ? await this.dependencies.credentials.resolve(userId, configuredModel)
          : {
              apiKey: await this.dependencies.client.resolveAPIKey(userId, configuredModel),
              model: configuredModel,
              source: "user" as const,
              fallbackReason: null,
            };
        debugId = this.dependencies.debug?.start({
          telegramUserId: userId,
          chatId,
          chatType: "private",
          messageId: last.userMessageId,
          kind: "memory_compaction",
          model: credential.model,
          promptRefs: [
            promptReference("mia.context-compaction"),
            promptReference("mia.context-compaction-input"),
          ],
          contextLayers: {
            systemRules: promptReference("mia.context-compaction"),
            conversation: { chatType: "private", batchSize: CONTEXT_TURN_BATCH_SIZE },
            longTermMemory: memories.map((item) => ({ category: item.category, content: item.content })),
            rollingSummary: previousSummary,
            recentMessages: { order: "oldest_to_newest", dialogue: formatCompactionDialogue(messages, userId) },
          },
          requestPreview: prompt,
          details: {
            fromMessageId: first.userMessageId,
            throughMessageId: last.assistantMessageId,
            credentialSource: credential.source,
            credentialFallbackReason: credential.fallbackReason,
          },
        }) ?? null;
        const raw = await this.dependencies.client.structuredChat(
          credential.apiKey,
          credential.model,
          prompt,
          "mia_context_compaction",
          COMPACTION_JSON_SCHEMA,
        );
        const parsed = compactionResultSchema.parse(raw);
        const seen = new Set<string>();
        const safeMemories = parsed.memories.filter((memory) => {
          const normalized = memory.content.toLocaleLowerCase().replace(/\s+/g, " ").trim();
          if (SENSITIVE_VALUE.test(memory.content) || seen.has(normalized)) return false;
          seen.add(normalized);
          return true;
        });
        this.dependencies.store.applyPrivateCompaction({
          chatId,
          userId,
          turnIds: turns.map((turn) => turn.id),
          summary: parsed.summary,
          fromMessageId: first.userMessageId,
          throughMessageId: last.assistantMessageId,
          memories: safeMemories,
        });
        const previousSet = new Set(memories.map((item) => `${item.category}:${item.content}`));
        const nextSet = new Set(safeMemories.map((item) => `${item.category}:${item.content}`));
        this.dependencies.debug?.finish(debugId, {
          status: "succeeded",
          responsePreview: { memories: safeMemories, summary: parsed.summary },
          details: {
            fromMessageId: first.userMessageId,
            throughMessageId: last.assistantMessageId,
            added: safeMemories.filter((item) => !previousSet.has(`${item.category}:${item.content}`)),
            retained: safeMemories.filter((item) => previousSet.has(`${item.category}:${item.content}`)),
            consolidated: memories.filter((item) => !nextSet.has(`${item.category}:${item.content}`)),
          },
        });
        debugId = null;
      }
    } catch (error) {
      failed = true;
      this.dependencies.debug?.finish(debugId, {
        status: "failed",
        errorCode: error instanceof Error ? error.name.slice(0, 80) : "unknown_error",
      });
      this.dependencies.logger.warn({ err: error, chatId, userId }, "Mia context compaction failed");
    } finally {
      this.running.delete(chatId);
      if (!failed && this.dependencies.store.listPendingCompletedTurns(chatId, CONTEXT_TURN_BATCH_SIZE).length >= CONTEXT_TURN_BATCH_SIZE) {
        void this.compact(chatId, userId);
      }
    }
  }
}
