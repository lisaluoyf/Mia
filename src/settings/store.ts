import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { DEFAULT_PREFERENCES, type ModelPreferences } from "./types.js";

interface SettingsRow {
  chat_model: string | null;
  vision_model: string | null;
  image_model: string | null;
  video_model: string | null;
}

export interface SavePreferencesInput extends ModelPreferences {
  telegramUserId: number;
  apimasterUserId: number;
}

export class SettingsStore {
  private readonly database: Database.Database;

  constructor(
    databasePath: string,
    private readonly defaults: () => ModelPreferences = () => ({ ...DEFAULT_PREFERENCES }),
  ) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    const currentVersion = this.database.pragma("user_version", { simple: true }) as number;
    if (currentVersion > 2) {
      throw new Error(`Mia database schema ${currentVersion} is newer than this application supports`);
    }
    if (currentVersion === 0) {
      this.database.transaction(() => {
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS mia_user_settings (
        telegram_user_id INTEGER PRIMARY KEY,
        apimaster_user_id INTEGER NOT NULL,
        chat_model TEXT,
        image_model TEXT,
        video_model TEXT,
        vision_model TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
        `);
        this.database.pragma("user_version = 2");
      })();
      return;
    }
    if (currentVersion === 1) {
      this.database.transaction(() => {
        this.database.exec("ALTER TABLE mia_user_settings ADD COLUMN vision_model TEXT");
        this.database.pragma("user_version = 2");
      })();
    }
  }

  get(telegramUserId: number): ModelPreferences {
    const row = this.database.prepare(
      `SELECT chat_model, vision_model, image_model, video_model
       FROM mia_user_settings WHERE telegram_user_id = ?`,
    ).get(telegramUserId) as SettingsRow | undefined;
    if (!row) {
      return { ...this.defaults() };
    }
    return {
      chatModel: row.chat_model,
      visionModel: row.vision_model,
      imageModel: row.image_model,
      videoModel: row.video_model,
    };
  }

  save(input: SavePreferencesInput): ModelPreferences {
    this.database.prepare(`
      INSERT INTO mia_user_settings (
        telegram_user_id, apimaster_user_id, chat_model, vision_model, image_model, video_model
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        apimaster_user_id = excluded.apimaster_user_id,
        chat_model = excluded.chat_model,
        vision_model = excluded.vision_model,
        image_model = excluded.image_model,
        video_model = excluded.video_model,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      input.telegramUserId,
      input.apimasterUserId,
      input.chatModel,
      input.visionModel,
      input.imageModel,
      input.videoModel,
    );
    return {
      chatModel: input.chatModel,
      visionModel: input.visionModel,
      imageModel: input.imageModel,
      videoModel: input.videoModel,
    };
  }

  close(): void {
    this.database.close();
  }
}
