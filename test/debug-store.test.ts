import { describe, expect, it, vi } from "vitest";

import { DebugRecorder } from "../src/debug/recorder.js";
import { DebugService } from "../src/debug/service.js";
import { DebugStore } from "../src/debug/store.js";
import { PROMPT_LIBRARY, promptReference } from "../src/prompts.js";
import { createLogger } from "../src/logger.js";
import { ModelConfigStore } from "../src/model-config/store.js";
import { createServer } from "../src/server.js";
import { ContextStore } from "../src/storage/store.js";

const modelCatalog = {
  apimasterUserId: 9,
  models: [
    { id: "gpt-5.4", displayName: "GPT-5.4", vendor: "OpenAI", capability: "chat" as const, recommended: true, supportsVision: true, visionRecommended: true },
    { id: "text-only", displayName: "Text only", vendor: "Test", capability: "chat" as const, recommended: false, supportsVision: false, visionRecommended: false },
    { id: "gpt-image-2", displayName: "GPT Image 2", vendor: "OpenAI", capability: "image" as const, recommended: true, supportsVision: false, visionRecommended: false },
    {
      id: "minimax-h3", displayName: "MiniMax H3", vendor: "MiniMax", capability: "video" as const,
      recommended: true, supportsVision: false, visionRecommended: false,
      videoCapabilities: {
        modes: ["text_to_video" as const, "image_to_video" as const],
        durationSeconds: { min: 1, max: 10, default: 5 },
        resolutions: ["720p"], defaultResolution: "720p", aspectRatios: ["16:9"],
        defaultAspectRatio: "16:9", maxReferenceImages: 1,
      },
    },
    { id: "video-without-options", displayName: "Unavailable video", vendor: "Test", capability: "video" as const, recommended: false, supportsVision: false, visionRecommended: false },
  ],
};

describe("developer debug snapshots", () => {
  it("records only allowlisted Telegram users and redacts secrets and binary payloads", () => {
    const store = new DebugStore(":memory:");
    const recorder = new DebugRecorder(store, [42]);
    expect(recorder.start({ telegramUserId: 7, kind: "chat", model: "grok", requestPreview: "ignored" })).toBeNull();

    const id = recorder.start({
      telegramUserId: 42,
      kind: "chat",
      model: "grok-4.5",
      promptRefs: [promptReference("mia.system")],
      requestPreview: {
        authorization: "Bearer private",
        key: "api_key=sk-1234567890abcdef",
        image: "data:image/png;base64,aGVsbG8=",
        bytes: new Uint8Array([1, 2, 3]),
      },
    });
    expect(id).toBeTypeOf("string");
    recorder.finish(id, { status: "succeeded", responsePreview: "ok" });
    const request = store.list(42)[0];
    expect(JSON.stringify(request)).not.toContain("private");
    expect(JSON.stringify(request)).not.toContain("sk-1234567890abcdef");
    expect(JSON.stringify(request)).not.toContain("aGVsbG8=");
    expect(request?.status).toBe("succeeded");
    expect(store.list(7)).toEqual([]);
    store.close();
  });

  it("keeps only the newest configured number of snapshots per user", () => {
    const store = new DebugStore(":memory:", { maxPerUser: 2 });
    for (let index = 0; index < 3; index += 1) {
      store.start({ telegramUserId: 42, kind: "chat", model: `model-${index}` });
    }
    expect(store.list(42).map((item) => item.model)).toEqual(["model-2", "model-1"]);
    store.close();
  });

  it("exposes isolated internal routes, memory state, and the versioned prompt library", async () => {
    const debugStore = new DebugStore(":memory:");
    const contexts = new ContextStore(":memory:");
    const modelConfig = new ModelConfigStore(":memory:");
    const listModels = vi.fn(() => Promise.resolve(modelCatalog));
    contexts.upsertUser({ telegramUserId: 42, firstName: "Lisa", lastName: null, username: "lisa", languageCode: "en", isBot: false });
    contexts.addMemory({ scope: { type: "user", userId: 42 }, category: "identity", content: "Call the user Roma" });
    const requestId = debugStore.start({ telegramUserId: 42, kind: "chat", model: "grok-4.5" });
    const app = createServer({
      logger: createLogger("silent"),
      serviceKey: "test-internal-service-key",
      handleUpdate: vi.fn(),
      debug: new DebugService(debugStore, contexts, modelConfig, { listModels }),
    });
    const unauthorized = await app.inject({ method: "GET", url: "/internal/debug/requests?telegram_user_id=42" });
    expect(unauthorized.statusCode).toBe(404);
    const headers = { "x-mia-internal-key": "test-internal-service-key" };
    const requests = await app.inject({ method: "GET", url: "/internal/debug/requests?telegram_user_id=42", headers });
    expect(requests.body).toContain(requestId);
    const isolated = await app.inject({ method: "GET", url: `/internal/debug/requests/${requestId}?telegram_user_id=7`, headers });
    expect(isolated.statusCode).toBe(404);
    const memory = await app.inject({ method: "GET", url: "/internal/debug/memory?telegram_user_id=42", headers });
    expect(memory.body).toContain("Call the user Roma");
    const prompts = await app.inject({ method: "GET", url: "/internal/debug/prompts?telegram_user_id=42", headers });
    expect(prompts.body).toContain(PROMPT_LIBRARY[0]?.id);
    const modelConfigs = await app.inject({ method: "GET", url: "/internal/debug/model-config?telegram_user_id=42", headers });
    const modelPayload = modelConfigs.json<{ success: boolean; data: { configs: Array<{ key: string; model: string | null }>; models: Array<{ id: string }> } }>();
    expect(modelPayload.success).toBe(true);
    expect(modelPayload.data.configs.find((item) => item.key === "user_image_default")?.model).toBe("gpt-image-2");
    expect(modelPayload.data.configs.find((item) => item.key === "intent_router")?.model).toBe("gpt-5.4");
    expect(modelPayload.data.models.map((item) => item.id)).toContain("gpt-image-2");
    const saved = await app.inject({
      method: "PUT",
      url: "/internal/debug/model-config?telegram_user_id=42",
      headers: { ...headers, "content-type": "application/json" },
      payload: { intent_router: "GPT-5.4" },
    });
    expect(saved.statusCode).toBe(200);
    expect(modelConfig.get("intent_router")).toBe("gpt-5.4");

    for (const payload of [
      { intent_router: "gpt-image-2" },
      { user_vision_default: "text-only" },
      { user_image_default: "minimax-h3" },
      { user_video_default: "video-without-options" },
    ]) {
      const rejected = await app.inject({
        method: "PUT",
        url: "/internal/debug/model-config?telegram_user_id=42",
        headers: { ...headers, "content-type": "application/json" },
        payload,
      });
      expect(rejected.statusCode).toBe(422);
    }

    const validMedia = await app.inject({
      method: "PUT",
      url: "/internal/debug/model-config?telegram_user_id=42",
      headers: { ...headers, "content-type": "application/json" },
      payload: { user_vision_default: null, user_image_default: "GPT-IMAGE-2", user_video_default: "MINIMAX-H3" },
    });
    expect(validMedia.statusCode).toBe(200);
    expect(modelConfig.get("user_vision_default")).toBeNull();
    expect(modelConfig.get("user_image_default")).toBe("gpt-image-2");
    expect(modelConfig.get("user_video_default")).toBe("minimax-h3");

    modelConfig.save({ guest_chat: "retired-chat-model" });
    const savesAroundUnavailable = await app.inject({
      method: "PUT",
      url: "/internal/debug/model-config?telegram_user_id=42",
      headers: { ...headers, "content-type": "application/json" },
      payload: { intent_router: "gpt-5.4" },
    });
    expect(savesAroundUnavailable.statusCode).toBe(200);
    expect(modelConfig.get("guest_chat")).toBe("retired-chat-model");
    const invalid = await app.inject({
      method: "PUT",
      url: "/internal/debug/model-config?telegram_user_id=42",
      headers: { ...headers, "content-type": "application/json" },
      payload: { guest_chat: null },
    });
    expect(invalid.statusCode).toBe(422);
    await app.close();
    modelConfig.close();
    contexts.close();
    debugStore.close();
  });

  it("returns a service-unavailable error when the API Master model catalog cannot be loaded", async () => {
    const debugStore = new DebugStore(":memory:");
    const contexts = new ContextStore(":memory:");
    const modelConfig = new ModelConfigStore(":memory:");
    const app = createServer({
      logger: createLogger("silent"),
      serviceKey: "test-internal-service-key",
      handleUpdate: vi.fn(),
      debug: new DebugService(debugStore, contexts, modelConfig, { listModels: vi.fn().mockRejectedValue(new Error("offline")) }),
    });
    const response = await app.inject({
      method: "GET",
      url: "/internal/debug/model-config?telegram_user_id=42",
      headers: { "x-mia-internal-key": "test-internal-service-key" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ success: false, error: "model_catalog_unavailable" });
    await app.close();
    modelConfig.close();
    contexts.close();
    debugStore.close();
  });
});
