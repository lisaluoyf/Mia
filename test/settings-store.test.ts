import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { DEFAULT_PREFERENCES } from "../src/settings/types.js";
import { SettingsStore } from "../src/settings/store.js";

describe("settings store", () => {
  it("provides defaults and persists all model preferences", () => {
    const store = new SettingsStore(":memory:");
    expect(store.get(42)).toEqual(DEFAULT_PREFERENCES);
    expect(store.save({
      telegramUserId: 42,
      apimasterUserId: 7,
      chatModel: "gpt-5.5",
      visionModel: "gpt-5.5",
      imageModel: "gpt-image-2",
      videoModel: "minimax-h3",
    })).toEqual({
      chatModel: "gpt-5.5",
      visionModel: "gpt-5.5",
      imageModel: "gpt-image-2",
      videoModel: "minimax-h3",
    });
    expect(store.get(42).chatModel).toBe("gpt-5.5");
    store.close();
  });

  it("migrates a version 1 database without losing preferences", () => {
    const directory = mkdtempSync(join(tmpdir(), "mia-settings-v1-"));
    const databasePath = join(directory, "mia.sqlite");
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE mia_user_settings (
        telegram_user_id INTEGER PRIMARY KEY,
        apimaster_user_id INTEGER NOT NULL,
        chat_model TEXT,
        image_model TEXT,
        video_model TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO mia_user_settings (
        telegram_user_id, apimaster_user_id, chat_model, image_model, video_model
      ) VALUES (42, 7, 'grok-4.5', 'gpt-image-2', 'minimax-h3');
      PRAGMA user_version = 1;
    `);
    database.close();

    let store: SettingsStore | undefined;
    try {
      store = new SettingsStore(databasePath);
      expect(store.get(42)).toEqual({
        chatModel: "grok-4.5",
        visionModel: null,
        imageModel: "gpt-image-2",
        videoModel: "minimax-h3",
      });
    } finally {
      store?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
