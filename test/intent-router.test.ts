import { describe, expect, it, vi } from "vitest";

import { IntentRouter, validateIntentRequirements } from "../src/intent/router.js";

const base = {
  text: "生成一张海边日落图片",
  mediaType: "none" as const,
  mediaCount: 0,
  replyMediaCount: 0,
  activePrivateImage: false,
};

describe("Mia intent router", () => {
  it("accepts strict structured image output and extracts requirements", async () => {
    const structuredChat = vi.fn().mockResolvedValue({
      intent: "image_generate",
      confidence: 0.96,
      instruction: "海边日落",
      media_source: "none",
      image_options: { aspect_ratio: "16:9" },
      video_options: null,
    });
    const router = new IntentRouter({ structuredChat }, {
      model: "router-model",
      timeoutMs: 1000,
    });
    await expect(router.classify(base, "user-router-key")).resolves.toMatchObject({
      intent: "image_generate",
      instruction: "海边日落",
      missingRequired: [],
    });
    const call: unknown[] = structuredChat.mock.calls[0] ?? [];
    const model = call[1];
    const messages = call[2];
    const schemaName = call[3];
    expect(call[0]).toBe("user-router-key");
    expect(model).toBe("router-model");
    expect(schemaName).toBe("mia_media_intent");
    expect(JSON.stringify(messages)).not.toContain("image_url");
  });

  it("falls back to chat for timeout, invalid schema, and low confidence", async () => {
    for (const output of [new Error("timeout"), { intent: "hack" }, {
      intent: "video_generate", confidence: 0.2, instruction: "script", media_source: "none",
      image_options: null, video_options: { mode: "text_to_video", duration_seconds: null, aspect_ratio: null, resolution: null, image_roles: [] },
    }]) {
      const structuredChat = output instanceof Error ? vi.fn().mockRejectedValue(output) : vi.fn().mockResolvedValue(output);
      const router = new IntentRouter({ structuredChat }, {
        model: "router", timeoutMs: 1000,
      });
      const result = await router.classify(base, "user-key");
      expect(result.intent).toBe("chat");
      expect(result.fallbackReason).toBeTruthy();
    }
  });

  it("requires an image for edit, vision and image-to-video", () => {
    const shared = { confidence: 1, instruction: "do it", media_source: "none" as const, image_options: null, final_response: null };
    expect(validateIntentRequirements({ ...shared, intent: "image_edit", video_options: null }, base)).toContain("image");
    expect(validateIntentRequirements({ ...shared, intent: "vision_qa", video_options: null }, base)).toContain("image");
    expect(validateIntentRequirements({ ...shared, intent: "video_generate", video_options: {
      mode: "image_to_video", duration_seconds: 4, aspect_ratio: "16:9", resolution: "768P", image_roles: [],
    } }, base)).toContain("image");
  });

  it("returns final chat and vision answers from the same GPT-5.4 call", async () => {
    const structuredChat = vi.fn().mockResolvedValue({
      intent: "vision_qa",
      confidence: 0.99,
      instruction: "第二行是什么意思？",
      media_source: "message",
      image_options: null,
      video_options: null,
      final_response: "第二行表示服务器连接失败。",
    });
    const router = new IntentRouter({ structuredChat }, { model: "gpt-5.4", timeoutMs: 1000 });
    const result = await router.classify({
      ...base,
      text: "第二行是什么意思？",
      mediaType: "image",
      mediaCount: 1,
    }, "user-key", [{ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", filename: "screen.png" }]);
    expect(result).toMatchObject({ intent: "vision_qa", final_response: "第二行表示服务器连接失败。" });
    expect(JSON.stringify(structuredChat.mock.calls[0]?.[2])).toContain("data:image/png;base64,AQID");
  });
});
