import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import {
  MODEL_CONFIG_DEFINITIONS,
  modelConfigDefaults,
  type ModelConfigEntry,
  type ModelConfigKey,
  type ModelConfigValues,
} from "./types.js";

interface ConfigRow {
  config_key: ModelConfigKey;
  model: string | null;
  updated_at: string | null;
}

export class ModelConfigStore {
  private readonly database: Database.Database;

  constructor(databasePath: string, initial: Partial<ModelConfigValues> = {}) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.migrate();
    this.seed(initial);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS mia_model_config (
        config_key TEXT PRIMARY KEY,
        model TEXT,
        updated_at TEXT
      );
    `);
    this.database.prepare("DELETE FROM mia_model_config WHERE config_key = 'group_summary'").run();
  }

  private seed(initial: Partial<ModelConfigValues>): void {
    const defaults = modelConfigDefaults(initial);
    const insert = this.database.prepare(`
      INSERT INTO mia_model_config (config_key, model, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(config_key) DO NOTHING
    `);
    const transaction = this.database.transaction(() => {
      for (const definition of MODEL_CONFIG_DEFINITIONS) insert.run(definition.key, defaults[definition.key]);
    });
    transaction();
  }

  list(): ModelConfigEntry[] {
    const rows = this.database.prepare(
      "SELECT config_key, model, updated_at FROM mia_model_config",
    ).all() as ConfigRow[];
    const byKey = new Map(rows.map((row) => [row.config_key, row]));
    return MODEL_CONFIG_DEFINITIONS.map((definition) => ({
      ...definition,
      model: byKey.get(definition.key)?.model ?? definition.defaultModel,
      updatedAt: byKey.get(definition.key)?.updated_at ?? null,
    }));
  }

  values(): ModelConfigValues {
    return Object.fromEntries(this.list().map((entry) => [entry.key, entry.model])) as ModelConfigValues;
  }

  get(key: ModelConfigKey): string | null {
    return this.values()[key];
  }

  save(values: Partial<ModelConfigValues>): ModelConfigEntry[] {
    const definitions = new Map(MODEL_CONFIG_DEFINITIONS.map((definition) => [definition.key, definition]));
    const update = this.database.prepare(
      "UPDATE mia_model_config SET model = ?, updated_at = CURRENT_TIMESTAMP WHERE config_key = ?",
    );
    const transaction = this.database.transaction(() => {
      for (const [key, model] of Object.entries(values)) {
        const definition = definitions.get(key as ModelConfigKey);
        if (!definition) throw new Error(`Unknown model config: ${key}`);
        if (model === null && definition.capability !== "vision") {
          throw new Error(`Model config cannot be empty: ${key}`);
        }
        if (model !== null && (typeof model !== "string" || model.trim() === "" || model.length > 200)) {
          throw new Error(`Invalid model config: ${key}`);
        }
        update.run(model === null ? null : model.trim(), key);
      }
    });
    transaction();
    return this.list();
  }

  userDefaults(): {
    chatModel: string | null;
    visionModel: string | null;
    imageModel: string | null;
    videoModel: string | null;
  } {
    const values = this.values();
    return {
      chatModel: values.user_chat_default,
      visionModel: values.user_vision_default,
      imageModel: values.user_image_default,
      videoModel: values.user_video_default,
    };
  }

  close(): void {
    this.database.close();
  }
}
