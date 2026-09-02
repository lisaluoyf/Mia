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
      imageModel: "gpt-image-2",
      videoModel: "minimax-h3",
    })).toEqual({
      chatModel: "gpt-5.5",
      imageModel: "gpt-image-2",
      videoModel: "minimax-h3",
    });
    expect(store.get(42).chatModel).toBe("gpt-5.5");
    store.close();
  });
});
