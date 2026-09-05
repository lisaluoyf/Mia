import type { APIMasterClient, ModelCatalog } from "../clients/apimaster.js";
import {
  DEFAULT_PREFERENCES,
  preferenceKey,
  type ModelOption,
  type ModelPreferenceCapability,
  type ModelPreferences,
} from "./types.js";
import type { SettingsStore } from "./store.js";

export class InvalidModelPreferenceError extends Error {
  constructor(public readonly capability: ModelPreferenceCapability) {
    super(`Invalid ${capability} model preference`);
    this.name = "InvalidModelPreferenceError";
  }
}

export interface SettingsSnapshot extends ModelCatalog {
  settings: ModelPreferences;
  unavailable: ModelPreferenceCapability[];
}

interface CachedCatalog {
  catalog: ModelCatalog;
  expiresAt: number;
}

export function sameModelId(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left.toLowerCase() === right.toLowerCase();
}

function candidatesFor(capability: ModelPreferenceCapability, catalog: ModelCatalog): ModelOption[] {
  return catalog.models.filter((model) => (
    capability === "vision"
      ? model.capability === "chat" && model.supportsVision
      : capability === "video"
        ? model.capability === "video"
        : model.capability === capability
  ));
}

function availableModel(
  requested: string | null,
  capability: ModelPreferenceCapability,
  catalog: ModelCatalog,
): string | null {
  const candidates = candidatesFor(capability, catalog);
  const requestedModel = requested && candidates.find((model) => sameModelId(model.id, requested));
  if (requestedModel) {
    return requestedModel.id;
  }
  const defaultModel = DEFAULT_PREFERENCES[preferenceKey(capability)];
  const catalogDefault = defaultModel && candidates.find((model) => sameModelId(model.id, defaultModel));
  if (catalogDefault) {
    return catalogDefault.id;
  }
  if (capability === "vision") {
    return candidates.find((model) => model.visionRecommended)?.id ?? candidates[0]?.id ?? null;
  }
  return candidates.find((model) => model.recommended)?.id ?? candidates[0]?.id ?? null;
}

function withDefaultRecommendations(catalog: ModelCatalog, defaults: ModelPreferences): ModelCatalog {
  return {
    ...catalog,
    // The APIMaster catalog is shared and cached. Add Mia's managed defaults only
    // to the response snapshot so a user selection never changes what is recommended.
    models: catalog.models.map((model) => ({
      ...model,
      recommended: model.recommended
        || (model.capability === "chat" && sameModelId(model.id, defaults.chatModel))
        || (model.capability === "image" && sameModelId(model.id, defaults.imageModel))
        || (model.capability === "video" && sameModelId(model.id, defaults.videoModel)),
      visionRecommended: model.visionRecommended
        || (model.capability === "chat"
          && model.supportsVision
          && sameModelId(model.id, defaults.visionModel)),
    })),
  };
}

export class ModelSettingsService {
  private readonly catalogCache = new Map<number, CachedCatalog>();
  private readonly catalogRequests = new Map<number, Promise<ModelCatalog>>();

  constructor(
    private readonly client: APIMasterClient,
    private readonly store: SettingsStore,
    private readonly defaults: () => ModelPreferences = () => ({ ...DEFAULT_PREFERENCES }),
    private readonly catalogCacheTtlMs = 2 * 60 * 1_000,
  ) {}

  getDefaults(): ModelPreferences {
    return { ...this.defaults() };
  }

  getPreferences(telegramUserId: number): ModelPreferences {
    const stored = this.store.get(telegramUserId);
    const defaults = this.defaults();
    return {
      chatModel: stored.chatModel ?? defaults.chatModel,
      visionModel: stored.visionModel ?? defaults.visionModel,
      imageModel: stored.imageModel ?? defaults.imageModel,
      videoModel: stored.videoModel ?? defaults.videoModel,
    };
  }

  async getSnapshot(telegramUserId: number): Promise<SettingsSnapshot> {
    const catalog = await this.getCatalog(telegramUserId);
    const stored = this.store.get(telegramUserId);
    const defaults = this.defaults();
    const unavailable: ModelPreferenceCapability[] = [];
    const normalized = { ...stored };
    for (const capability of ["chat", "vision", "image", "video"] as const) {
      const key = preferenceKey(capability);
      const selected = stored[key];
      const effective = availableModel(selected ?? defaults[key], capability, catalog);
      if (selected && (!effective || !sameModelId(selected, effective))) {
        unavailable.push(capability);
      }
      normalized[key] = effective;
    }
    return { ...withDefaultRecommendations(catalog, defaults), settings: normalized, unavailable };
  }

  async save(telegramUserId: number, preferences: ModelPreferences): Promise<ModelPreferences> {
    // An explicit model selection must validate against the live catalog,
    // rather than a short-lived snapshot shown while the Mini App opens.
    const catalog = await this.getCatalog(telegramUserId, true);
    const normalized = { ...preferences };
    for (const capability of ["chat", "vision", "image", "video"] as const) {
      const key = preferenceKey(capability);
      const selected = preferences[key];
      const canonical = selected === null
        ? undefined
        : candidatesFor(capability, catalog).find((model) => sameModelId(model.id, selected));
      if (selected && !canonical) {
        throw new InvalidModelPreferenceError(capability);
      }
      normalized[key] = canonical?.id ?? null;
    }
    return this.store.save({
      telegramUserId,
      apimasterUserId: catalog.apimasterUserId,
      ...normalized,
    });
  }

  private async getCatalog(telegramUserId: number, forceRefresh = false): Promise<ModelCatalog> {
    const cached = this.catalogCache.get(telegramUserId);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.catalog;
    }
    const pending = this.catalogRequests.get(telegramUserId);
    if (pending) return pending;

    const request = this.client.listModels(telegramUserId)
      .then((catalog) => {
        this.catalogCache.set(telegramUserId, {
          catalog,
          expiresAt: Date.now() + this.catalogCacheTtlMs,
        });
        return catalog;
      })
      .finally(() => this.catalogRequests.delete(telegramUserId));
    this.catalogRequests.set(telegramUserId, request);
    return request;
  }
}
