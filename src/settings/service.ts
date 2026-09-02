import type { APIMasterClient, ModelCatalog } from "../clients/apimaster.js";
import { DEFAULT_PREFERENCES, preferenceKey, type ModelCapability, type ModelPreferences } from "./types.js";
import type { SettingsStore } from "./store.js";

export class InvalidModelPreferenceError extends Error {
  constructor(public readonly capability: ModelCapability) {
    super(`Invalid ${capability} model preference`);
    this.name = "InvalidModelPreferenceError";
  }
}

export interface SettingsSnapshot extends ModelCatalog {
  settings: ModelPreferences;
  unavailable: ModelCapability[];
}

function availableModel(
  requested: string | null,
  capability: ModelCapability,
  catalog: ModelCatalog,
): string | null {
  const candidates = catalog.models.filter((model) => model.capability === capability);
  if (requested && candidates.some((model) => model.id === requested)) {
    return requested;
  }
  const defaultModel = DEFAULT_PREFERENCES[preferenceKey(capability)];
  if (defaultModel && candidates.some((model) => model.id === defaultModel)) {
    return defaultModel;
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
    const unavailable: ModelCapability[] = [];
    const normalized = { ...stored };
    for (const capability of ["chat", "image", "video"] as const) {
      const key = preferenceKey(capability);
      const selected = stored[key];
      const effective = availableModel(selected, capability, catalog);
      if (selected && selected !== effective) {
        unavailable.push(capability);
      }
      normalized[key] = effective;
    }
    return { ...catalog, settings: normalized, unavailable };
  }

  async save(telegramUserId: number, preferences: ModelPreferences): Promise<ModelPreferences> {
    const catalog = await this.client.listModels(telegramUserId);
    for (const capability of ["chat", "image", "video"] as const) {
      const selected = preferences[preferenceKey(capability)];
      if (selected && !catalog.models.some((model) => model.id === selected && model.capability === capability)) {
        throw new InvalidModelPreferenceError(capability);
      }
    }
    return this.store.save({
      telegramUserId,
      apimasterUserId: catalog.apimasterUserId,
      ...preferences,
    });
  }
}
