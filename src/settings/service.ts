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

function sameModel(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left.toLowerCase() === right.toLowerCase();
}

function candidatesFor(capability: ModelPreferenceCapability, catalog: ModelCatalog): ModelOption[] {
  return catalog.models.filter((model) => capability === "vision"
    ? model.capability === "chat" && model.supportsVision
    : model.capability === capability);
}

function availableModel(
  requested: string | null,
  capability: ModelPreferenceCapability,
  catalog: ModelCatalog,
): string | null {
  const candidates = candidatesFor(capability, catalog);
  const requestedModel = requested && candidates.find((model) => sameModel(model.id, requested));
  if (requestedModel) {
    return requestedModel.id;
  }
  const defaultModel = DEFAULT_PREFERENCES[preferenceKey(capability)];
  const catalogDefault = defaultModel && candidates.find((model) => sameModel(model.id, defaultModel));
  if (catalogDefault) {
    return catalogDefault.id;
  }
  if (capability === "vision") {
    return candidates.find((model) => model.visionRecommended)?.id ?? candidates[0]?.id ?? null;
  }
  return candidates.find((model) => model.recommended)?.id ?? candidates[0]?.id ?? null;
}

export class ModelSettingsService {
  constructor(
    private readonly client: APIMasterClient,
    private readonly store: SettingsStore,
  ) {}

  getPreferences(telegramUserId: number): ModelPreferences {
    return this.store.get(telegramUserId);
  }

  async getSnapshot(telegramUserId: number): Promise<SettingsSnapshot> {
    const catalog = await this.client.listModels(telegramUserId);
    const stored = this.store.get(telegramUserId);
    const unavailable: ModelPreferenceCapability[] = [];
    const normalized = { ...stored };
    for (const capability of ["chat", "vision", "image", "video"] as const) {
      const key = preferenceKey(capability);
      const selected = stored[key];
      const effective = availableModel(selected, capability, catalog);
      if (selected && (!effective || !sameModel(selected, effective))) {
        unavailable.push(capability);
      }
      normalized[key] = effective;
    }
    return { ...catalog, settings: normalized, unavailable };
  }

  async save(telegramUserId: number, preferences: ModelPreferences): Promise<ModelPreferences> {
    const catalog = await this.client.listModels(telegramUserId);
    const normalized = { ...preferences };
    for (const capability of ["chat", "vision", "image", "video"] as const) {
      const key = preferenceKey(capability);
      const selected = preferences[key];
      const canonical = selected === null
        ? undefined
        : candidatesFor(capability, catalog).find((model) => sameModel(model.id, selected));
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
}
