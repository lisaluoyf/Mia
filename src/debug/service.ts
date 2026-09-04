import type { ContextStore } from "../storage/store.js";
import { PROMPT_LIBRARY } from "../prompts.js";
import type { DebugStore } from "./store.js";
import type { ModelConfigStore } from "../model-config/store.js";
import { MODEL_CONFIG_DEFINITIONS, type ModelConfigEntry } from "../model-config/types.js";
import type { APIMasterClient } from "../clients/apimaster.js";
import type { ModelOption } from "../settings/types.js";
import type { PromptConfigStore } from "../prompt-config/store.js";

export class ModelCatalogUnavailableError extends Error {
  constructor() {
    super("Model catalog is unavailable");
    this.name = "ModelCatalogUnavailableError";
  }
}

export class InvalidModelConfigError extends Error {
  constructor() {
    super("Invalid model configuration");
    this.name = "InvalidModelConfigError";
  }
}

export interface DebugModelConfigState {
  configs: ModelConfigEntry[];
  models: ModelOption[];
}

export class DebugService {
  constructor(
    private readonly debugStore: DebugStore,
    private readonly contexts: Pick<ContextStore, "listMemories" | "getLatestSummary" | "listPendingCompletedTurns">,
    private readonly modelConfig: ModelConfigStore,
    private readonly client: Pick<APIMasterClient, "listModels">,
    private readonly promptConfigs?: PromptConfigStore,
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
    return this.promptConfigs?.list() ?? PROMPT_LIBRARY;
  }

  savePrompt(id: string, text: unknown) {
    if (!this.promptConfigs) throw new Error("Prompt configuration is unavailable");
    return this.promptConfigs.save(id, text);
  }

  clear(telegramUserId: number) {
    return { cleared: this.debugStore.clear(telegramUserId) };
  }

  async modelConfigs(telegramUserId: number): Promise<DebugModelConfigState> {
    try {
      const catalog = await this.client.listModels(telegramUserId);
      return { configs: this.modelConfig.list(), models: catalog.models };
    } catch {
      throw new ModelCatalogUnavailableError();
    }
  }

  async saveModelConfigs(telegramUserId: number, values: Record<string, string | null>): Promise<DebugModelConfigState> {
    let models: ModelOption[];
    try {
      models = (await this.client.listModels(telegramUserId)).models;
    } catch {
      throw new ModelCatalogUnavailableError();
    }

    const definitions = new Map(MODEL_CONFIG_DEFINITIONS.map((definition) => [definition.key, definition]));
    const normalized: Record<string, string | null> = {};
    for (const [key, requested] of Object.entries(values)) {
      const definition = definitions.get(key as (typeof MODEL_CONFIG_DEFINITIONS)[number]["key"]);
      if (!definition || (requested === null && definition.capability !== "vision")) {
        throw new InvalidModelConfigError();
      }
      if (requested === null) {
        normalized[key] = null;
        continue;
      }
      const model = models.find((candidate) => candidate.id.toLowerCase() === requested.toLowerCase());
      const valid = model && (
        definition.capability === "vision"
          ? model.capability === "chat" && model.supportsVision
          : definition.capability === "video"
            ? model.capability === "video" && model.videoCapabilities !== undefined
            : model.capability === definition.capability
      );
      if (!valid) throw new InvalidModelConfigError();
      normalized[key] = model.id;
    }

    return { configs: this.modelConfig.save(normalized), models };
  }
}
