import type { ContextStore } from "../storage/store.js";
import { PROMPT_LIBRARY } from "../prompts.js";
import type { DebugStore } from "./store.js";
import type { ModelConfigStore } from "../model-config/store.js";

export class DebugService {
  constructor(
    private readonly debugStore: DebugStore,
    private readonly contexts: Pick<ContextStore, "listMemories" | "getLatestSummary" | "listPendingCompletedTurns">,
    private readonly modelConfig: ModelConfigStore,
  ) {}

  requests(telegramUserId: number) {
    return this.debugStore.list(telegramUserId);
  }

  request(telegramUserId: number, id: string) {
    return this.debugStore.get(telegramUserId, id);
  }

  memory(telegramUserId: number) {
    const scope = { type: "private" as const, chatId: telegramUserId };
    const compactions = this.debugStore.list(telegramUserId)
      .filter((request) => request.kind === "memory_compaction");
    return {
      memories: this.contexts.listMemories({ type: "user", userId: telegramUserId }, 100),
      summary: this.contexts.getLatestSummary(scope),
      pendingTurns: this.contexts.listPendingCompletedTurns(telegramUserId, 100).length,
      batchSize: 10,
      lastCompaction: compactions[0] ?? null,
      history: compactions,
    };
  }

  prompts() {
    return PROMPT_LIBRARY;
  }

  clear(telegramUserId: number) {
    return { cleared: this.debugStore.clear(telegramUserId) };
  }

  modelConfigs() {
    return this.modelConfig.list();
  }

  saveModelConfigs(values: Record<string, string | null>) {
    return this.modelConfig.save(values);
  }
}
