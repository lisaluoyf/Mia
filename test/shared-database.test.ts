import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SettingsStore } from "../src/settings/store.js";
import { ContextStore } from "../src/storage/store.js";

describe("shared Mia database", () => {
  let temporaryDirectory: string | undefined;

  afterEach(() => {
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("stores global settings and isolated conversation data in one SQLite file", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "mia-database-test-"));
    const databasePath = join(temporaryDirectory, "mia.sqlite");
    const settings = new SettingsStore(databasePath);
    const contexts = new ContextStore(databasePath);

    settings.save({
      telegramUserId: 42,
      apimasterUserId: 7,
      chatModel: "grok-4.5",
      imageModel: "gpt-image-2",
      videoModel: "minimax-h3",
    });
    contexts.upsertUser({
      telegramUserId: 42,
      firstName: "Mia",
      lastName: null,
      username: null,
      languageCode: "zh-CN",
      isBot: false,
    });

    expect(settings.get(42).videoModel).toBe("minimax-h3");
    expect(contexts.getUser(42)?.languageCode).toBe("zh-CN");

    contexts.close();
    settings.close();
  });
});
