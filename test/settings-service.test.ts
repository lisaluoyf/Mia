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
  const listModels = vi.fn(() => Promise.resolve(catalog));
  const client = { listModels } as unknown as APIMasterClient;
  return { current: new ModelSettingsService(client, store), save, listModels };
}

describe("model ID matching", () => {
  it("caches the catalog used by repeated Mini App bootstraps", async () => {
    const { current, listModels } = service();

    await current.getSnapshot(42);
    await current.getSnapshot(42);

    expect(listModels).toHaveBeenCalledTimes(1);
  });

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

  it("uses changed global defaults only when the user has no selected model", () => {
    const defaults: ModelPreferences = {
      chatModel: "gpt-5.5",
      visionModel: null,
      imageModel: "gpt-image-2",
      videoModel: "minimax-h3",
    };
    const store = { get: vi.fn(() => ({
      chatModel: null,
      visionModel: null,
      imageModel: "user-image-model",
      videoModel: null,
    })) } as unknown as SettingsStore;
    const client = { listModels: vi.fn(() => Promise.resolve(catalog)) } as unknown as APIMasterClient;
    const current = new ModelSettingsService(client, store, () => ({ ...defaults }));

    expect(current.getPreferences(42)).toEqual({
      chatModel: "gpt-5.5",
      visionModel: null,
      imageModel: "user-image-model",
      videoModel: "minimax-h3",
    });

    defaults.chatModel = "grok-4.5";
    expect(current.getPreferences(42).chatModel).toBe("grok-4.5");
    expect(current.getPreferences(42).imageModel).toBe("user-image-model");
  });

  it("marks Mia global defaults as recommended without changing cached catalog metadata", async () => {
    const defaults: ModelPreferences = {
      chatModel: "chat-default",
      visionModel: "vision-default",
      imageModel: "image-default",
      videoModel: "video-default",
    };
    const plainCatalog: ModelCatalog = {
      apimasterUserId: 7,
      models: [
        { id: "chat-default", displayName: "Chat default", vendor: "Test", capability: "chat", recommended: false, supportsVision: false, visionRecommended: false },
        { id: "vision-default", displayName: "Vision default", vendor: "Test", capability: "chat", recommended: false, supportsVision: true, visionRecommended: false },
        { id: "api-recommended", displayName: "API recommended", vendor: "Test", capability: "chat", recommended: true, supportsVision: true, visionRecommended: true },
        { id: "image-default", displayName: "Image default", vendor: "Test", capability: "image", recommended: false, supportsVision: false, visionRecommended: false },
        { id: "video-default", displayName: "Video default", vendor: "Test", capability: "video", recommended: false, supportsVision: false, visionRecommended: false },
      ],
    };
    const store = { get: vi.fn(() => ({
      chatModel: "api-recommended",
      visionModel: "api-recommended",
      imageModel: null,
      videoModel: null,
    })) } as unknown as SettingsStore;
    const client = { listModels: vi.fn(() => Promise.resolve(plainCatalog)) } as unknown as APIMasterClient;
    const current = new ModelSettingsService(client, store, () => ({ ...defaults }));

    const snapshot = await current.getSnapshot(42);
    const model = (id: string) => snapshot.models.find((item) => item.id === id)!;

    expect(model("chat-default").recommended).toBe(true);
    expect(model("vision-default").visionRecommended).toBe(true);
    expect(model("image-default").recommended).toBe(true);
    expect(model("video-default").recommended).toBe(true);
    expect(model("api-recommended")).toMatchObject({ recommended: true, visionRecommended: true });
    expect(snapshot.settings.chatModel).toBe("api-recommended");
    expect(plainCatalog.models.find((item) => item.id === "image-default")?.recommended).toBe(false);
  });
});
