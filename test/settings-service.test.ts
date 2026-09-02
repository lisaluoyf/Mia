import { describe, expect, it, vi } from "vitest";

import type { APIMasterClient, ModelCatalog } from "../src/clients/apimaster.js";
import { ModelSettingsService } from "../src/settings/service.js";
import type { SettingsStore } from "../src/settings/store.js";
import type { ModelPreferences } from "../src/settings/types.js";

const stored: ModelPreferences = {
  chatModel: "gpt-5.5",
  visionModel: "gpt-5.5",
  imageModel: "gpt-image-2",
  videoModel: "minimax-h3",
};

const catalog: ModelCatalog = {
  apimasterUserId: 7,
  models: [
    { id: "GPT-5.5", displayName: "GPT-5.5", vendor: "OpenAI", capability: "chat", recommended: true, supportsVision: true },
    { id: "GPT-Image-2", displayName: "GPT Image 2", vendor: "OpenAI", capability: "image", recommended: true },
    {
      id: "MiniMax-H3",
      displayName: "MiniMax H3",
      vendor: "MiniMax",
      capability: "video",
      recommended: true,
      videoCapabilities: {
        modes: ["text_to_video", "image_to_video"],
        durationSeconds: { min: 4, max: 15, default: 4 },
        resolutions: ["768P"],
        defaultResolution: "768P",
        aspectRatios: ["1:1", "16:9", "9:16"],
        defaultAspectRatio: "16:9",
        maxReferenceImages: 10,
      },
    },
  ],
};

function service() {
  const save = vi.fn((input: ModelPreferences) => ({
    chatModel: input.chatModel,
    visionModel: input.visionModel,
    imageModel: input.imageModel,
    videoModel: input.videoModel,
  }));
  const store = { get: vi.fn(() => stored), save } as unknown as SettingsStore;
  const client = { listModels: vi.fn(() => Promise.resolve(catalog)) } as unknown as APIMasterClient;
  return { current: new ModelSettingsService(client, store), save };
}

describe("model ID matching", () => {
  it("treats stored model IDs as case-insensitive and returns catalog casing", async () => {
    const { current } = service();

    const snapshot = await current.getSnapshot(42);

    expect(snapshot.settings).toEqual({
      chatModel: "GPT-5.5",
      visionModel: "GPT-5.5",
      imageModel: "GPT-Image-2",
      videoModel: "MiniMax-H3",
    });
    expect(snapshot.unavailable).toEqual([]);
  });

  it("accepts any casing on save and persists the catalog's canonical IDs", async () => {
    const { current, save } = service();

    const result = await current.save(42, stored);

    expect(result.videoModel).toBe("MiniMax-H3");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      chatModel: "GPT-5.5",
      visionModel: "GPT-5.5",
      imageModel: "GPT-Image-2",
      videoModel: "MiniMax-H3",
    }));
  });
});
