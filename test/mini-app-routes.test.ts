import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { APIMasterClient } from "../src/clients/apimaster.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { ModelSettingsService } from "../src/settings/service.js";
import { SettingsStore } from "../src/settings/store.js";

const botToken = "123456:test-token";

function signedInitData() {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "AAE",
    user: JSON.stringify({ id: 42, first_name: "Lisa", language_code: "zh-CN" }),
  });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

function modelCatalogResponse() {
  return Response.json({
    success: true,
    data: {
      user_id: 7,
      models: [
        { id: "grok-4.5", display_name: "Grok 4.5", vendor: "xAI", capability: "chat", recommended: true, supports_vision: false, vision_recommended: false, supported_endpoint_types: ["openai"] },
        { id: "gpt-5.5", display_name: "GPT-5.5", vendor: "OpenAI", capability: "chat", recommended: false, supports_vision: true, vision_recommended: true, supported_endpoint_types: ["openai"] },
        { id: "gpt-image-2", display_name: "GPT Image 2", vendor: "OpenAI", capability: "image", recommended: true, supported_endpoint_types: ["image-generation"] },
        {
          id: "MiniMax-H3", display_name: "MiniMax H3", vendor: "MiniMax", capability: "video", recommended: true,
          video_capabilities: {
            modes: ["text_to_video", "image_to_video"],
            duration_seconds: { min: 4, max: 15, default: 4 },
            resolutions: ["768P"], default_resolution: "768P",
            aspect_ratios: ["1:1", "16:9", "9:16"], default_aspect_ratio: "16:9", max_reference_images: 10,
          },
          supported_endpoint_types: ["openai-video"],
        },
      ],
    },
  });
}

describe("Mini App routes", () => {
  it("authenticates, loads the catalog, validates, and persists preferences", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(modelCatalogResponse()));
    const client = new APIMasterClient({
      baseUrl: "https://apimaster.example",
      internalBaseUrl: "http://127.0.0.1:3000",
      serviceKey: "internal-service-secret",
      timeoutMs: 5000,
      fetcher,
    });
    const store = new SettingsStore(":memory:");
    const settings = new ModelSettingsService(client, store);
    const app = createServer({
      logger: createLogger("silent"),
      serviceKey: "internal-service-secret",
      handleUpdate: vi.fn(),
      miniApp: { botToken, maxAuthAgeSeconds: 3600, settings },
    });
    const headers = { "x-telegram-init-data": signedInitData() };

    const bootstrap = await app.inject({ method: "GET", url: "/mia/api/bootstrap", headers });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toMatchObject({
      success: true,
      data: {
        user: { id: 42, firstName: "Lisa", languageCode: "zh-CN" },
        settings: { chatModel: "grok-4.5", visionModel: "gpt-5.5", imageModel: "gpt-image-2", videoModel: "MiniMax-H3" },
        unavailable: [],
      },
    });

    const invalid = await app.inject({
      method: "PUT",
      url: "/mia/api/settings",
      headers,
      payload: { chatModel: "minimax-h3", visionModel: "gpt-5.5", imageModel: "gpt-image-2", videoModel: "minimax-h3" },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ code: "invalid_model", field: "chat" });

    const saved = await app.inject({
      method: "PUT",
      url: "/mia/api/settings",
      headers,
      payload: { chatModel: "gpt-5.5", visionModel: "gpt-5.5", imageModel: "gpt-image-2", videoModel: "minimax-h3" },
    });
    expect(saved.statusCode).toBe(200);
    const reread = await app.inject({ method: "GET", url: "/mia/api/settings", headers });
    expect(reread.json()).toMatchObject({ data: { chatModel: "gpt-5.5", visionModel: "gpt-5.5", videoModel: "MiniMax-H3" } });

    const invalidVision = await app.inject({
      method: "PUT",
      url: "/mia/api/settings",
      headers,
      payload: { chatModel: "gpt-5.5", visionModel: "grok-4.5", imageModel: "gpt-image-2", videoModel: "minimax-h3" },
    });
    expect(invalidVision.statusCode).toBe(422);
    expect(invalidVision.json()).toMatchObject({ code: "invalid_model", field: "vision" });

    const legacySave = await app.inject({
      method: "PUT",
      url: "/mia/api/settings",
      headers,
      payload: { chatModel: "grok-4.5", imageModel: "gpt-image-2", videoModel: "minimax-h3" },
    });
    expect(legacySave.statusCode).toBe(200);
    expect(legacySave.json()).toMatchObject({ data: { visionModel: "gpt-5.5", videoModel: "MiniMax-H3" } });

    const forged = await app.inject({
      method: "GET",
      url: "/mia/api/bootstrap",
      headers: { "x-telegram-init-data": `${signedInitData()}x` },
    });
    expect(forged.statusCode).toBe(401);

    await app.close();
    store.close();
  });
});
