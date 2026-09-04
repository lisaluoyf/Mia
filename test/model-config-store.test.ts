import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ModelConfigStore } from "../src/model-config/store.js";
import { MODEL_CONFIG_KEYS, type ModelConfigValues } from "../src/model-config/types.js";

describe("model configuration store", () => {
  it("seeds all scenarios and maps user-facing defaults", () => {
    const store = new ModelConfigStore(":memory:", {
      intent_router: "router-from-env",
      user_chat_default: "chat-default",
    });

    expect(store.list().map((entry) => entry.key)).toEqual(MODEL_CONFIG_KEYS);
    expect(store.get("intent_router")).toBe("router-from-env");
    expect(store.userDefaults()).toEqual({
      chatModel: "chat-default",
      visionModel: null,
      imageModel: "gpt-image-2",
      videoModel: "minimax-h3",
    });
    store.close();
  });

  it("persists edits and uses environment values only for the first seed", () => {
    const directory = mkdtempSync(join(tmpdir(), "mia-model-config-"));
    const databasePath = join(directory, "mia.sqlite");
    try {
      const first = new ModelConfigStore(databasePath, { intent_router: "first-router" });
      first.save({ intent_router: "saved-router", user_vision_default: "vision-model" });
      first.close();

      const reopened = new ModelConfigStore(databasePath, { intent_router: "second-router" });
      expect(reopened.get("intent_router")).toBe("saved-router");
      expect(reopened.get("user_vision_default")).toBe("vision-model");
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown, empty, and invalid null configurations", () => {
    const store = new ModelConfigStore(":memory:");
    expect(() => store.save({ unknown: "model" } as unknown as Partial<ModelConfigValues>)).toThrow("Unknown model config");
    expect(() => store.save({ intent_router: "  " })).toThrow("Invalid model config");
    expect(() => store.save({ guest_chat: null })).toThrow("cannot be empty");
    expect(() => store.save({ user_vision_default: null })).not.toThrow();
    store.close();
  });
});
