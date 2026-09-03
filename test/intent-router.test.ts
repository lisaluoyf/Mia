import { describe, expect, it, vi } from "vitest";

import { IntentRouter, validateIntentRequirements } from "../src/intent/router.js";
import { PROMPT_LIBRARY } from "../src/prompts.js";

const base = {
  text: "生成一张海边日落图片",
  mediaType: "none" as const,
  mediaCount: 0,
  replyMediaCount: 0,
  activePrivateImage: false,
};

const noSearch = { callCount: 0, queries: [], sources: [] };
const response = (data: unknown, webSearch = noSearch) => ({ data, webSearch });

describe("Mia intent router", () => {
  it("accepts strict structured image output and extracts requirements", async () => {
    const structuredResponse = vi.fn().mockResolvedValue(response({
      intent: "image_generate",
      confidence: 0.96,
      instruction: "海边日落",
      media_source: "none",
      image_options: { aspect_ratio: "16:9" },
      video_options: null,
      final_response: null,
      conversation_mode: "task",
      onboarding_opportunity: false,
      profile_updates: null,
    }));
    const router = new IntentRouter({ structuredResponse }, {
      model: "router-model",
      timeoutMs: 1000,
    });
    await expect(router.classify(base, "user-router-key")).resolves.toMatchObject({
      intent: "image_generate",
      instruction: "海边日落",
      missingRequired: [],
    });
    const call: unknown[] = structuredResponse.mock.calls[0] ?? [];
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
      const structuredResponse = output instanceof Error ? vi.fn().mockRejectedValue(output) : vi.fn().mockResolvedValue(response(output));
      const router = new IntentRouter({ structuredResponse }, {
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
    const structuredResponse = vi.fn().mockResolvedValue(response({
      intent: "vision_qa",
      confidence: 0.99,
      instruction: "第二行是什么意思？",
      media_source: "message",
      image_options: null,
      video_options: null,
      final_response: "第二行表示服务器连接失败。",
      conversation_mode: "task",
      onboarding_opportunity: false,
      profile_updates: null,
    }));
    const router = new IntentRouter({ structuredResponse }, { model: "gpt-5.4", timeoutMs: 1000 });
    const result = await router.classify({
      ...base,
      text: "第二行是什么意思？",
      mediaType: "image",
      mediaCount: 1,
    }, "user-key", [{ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", filename: "screen.png" }]);
    expect(result).toMatchObject({ intent: "vision_qa", final_response: "第二行表示服务器连接失败。" });
    expect(JSON.stringify(structuredResponse.mock.calls[0]?.[2])).toContain("data:image/png;base64,AQID");
  });

  it("allows the credential resolver to force the guest GPT-5.4 model", async () => {
    const structuredResponse = vi.fn().mockResolvedValue(response({
      intent: "chat", confidence: 0.99, instruction: "", media_source: "none",
      image_options: null, video_options: null, final_response: "Hello",
      conversation_mode: "casual", onboarding_opportunity: false, profile_updates: null,
    }));
    const router = new IntentRouter({ structuredResponse }, { model: "configured-router", timeoutMs: 1000 });

    await router.classify(base, "guest-test-key", [], "gpt-5.4");

    expect(structuredResponse.mock.calls[0]?.[1]).toBe("gpt-5.4");
  });

  it("returns casual onboarding signals and explicit profile updates in the same call", async () => {
    const structuredResponse = vi.fn().mockResolvedValue(response({
      intent: "chat", confidence: 0.99, instruction: "", media_source: "none",
      image_options: null, video_options: null, final_response: "Nice to meet you, Roma.",
      conversation_mode: "casual", onboarding_opportunity: true,
      profile_updates: { preferred_name: "Roma", primary_role: "developer", primary_goal: null },
    }, { callCount: 1, queries: ["current developer tools"], sources: [] }));
    const router = new IntentRouter({ structuredResponse }, { model: "gpt-5.4", timeoutMs: 1000 });
    const result = await router.classify({ ...base, text: "Call me Roma. I'm a developer.", onboarding: { active: true, missingFields: ["preferred_name", "primary_role", "primary_goal"] } }, "key");
    expect(result).toMatchObject({ conversation_mode: "casual", onboarding_opportunity: true, profile_updates: { preferred_name: "Roma", primary_role: "developer", primary_goal: null } });
    expect(result.webSearch).toEqual({ callCount: 1, queries: ["current developer tools"], sources: [] });
    expect(structuredResponse).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(structuredResponse.mock.calls[0]?.[2])).toContain("missingFields");
  });

  it("returns group_summary only when the server marks the request as a group scope", async () => {
    const structuredResponse = vi.fn().mockResolvedValue(response({
      intent: "group_summary", confidence: 0.99, instruction: "", media_source: "none",
      image_options: null, video_options: null, final_response: null,
      conversation_mode: "task", onboarding_opportunity: false, profile_updates: null,
    }));
    const router = new IntentRouter({ structuredResponse }, { model: "gpt-5.4", timeoutMs: 1000 });

    await expect(router.classify({ ...base, text: "梳理一下大家刚才聊的重点", allowGroupSummary: true }, "key"))
      .resolves.toMatchObject({ intent: "group_summary", missingRequired: [] });
    await expect(router.classify({ ...base, text: "梳理一下", allowGroupSummary: false }, "key"))
      .resolves.toMatchObject({ intent: "chat", fallbackReason: "invalid_output" });
    expect(JSON.stringify(structuredResponse.mock.calls[0]?.[2])).toContain("allow_group_summary");
  });

  it("keeps only server-approved contextual media message IDs", async () => {
    const structuredResponse = vi.fn().mockResolvedValue(response({
      intent: "video_generate", confidence: 0.99, instruction: "让这张图动起来", media_source: "context",
      media_message_ids: [31, 999, 31], image_options: null,
      video_options: {
        mode: "image_to_video", duration_seconds: 6, aspect_ratio: "16:9", resolution: "768P",
        image_roles: ["first_frame"],
      },
      final_response: null, conversation_mode: "task", onboarding_opportunity: false, profile_updates: null,
    }));
    const router = new IntentRouter({ structuredResponse }, { model: "gpt-5.4", timeoutMs: 1000 });

    const result = await router.classify({
      ...base,
      text: "根据刚才那张图做一个 6 秒视频",
      mediaCandidates: [{
        messageId: 31, senderUserId: 42, type: "photo", sentAt: "2026-09-03T10:00:00.000Z",
        source: "current_user_recent",
      }],
    }, "key");

    expect(result).toMatchObject({ intent: "video_generate", media_source: "context", media_message_ids: [31] });
    expect(result.missingRequired).toEqual([]);
    const requestMessages = structuredResponse.mock.calls[0]?.[2] as Array<{ content: unknown }>;
    const metadata = JSON.parse(String(requestMessages[1]?.content)) as { media_candidates: Array<{ message_id: number }> };
    expect(metadata.media_candidates).toEqual([expect.objectContaining({ message_id: 31 })]);
    expect(metadata.media_candidates).not.toContainEqual(expect.objectContaining({ message_id: 999 }));
  });

  it("requires a second vision call when only contextual image metadata was provided", async () => {
    const structuredResponse = vi.fn().mockResolvedValue(response({
      intent: "vision_qa", confidence: 0.99, instruction: "图片里是什么？", media_source: "context",
      media_message_ids: [20], image_options: null, video_options: null, final_response: null,
      conversation_mode: "task", onboarding_opportunity: false, profile_updates: null,
    }));
    const router = new IntentRouter({ structuredResponse }, { model: "gpt-5.4", timeoutMs: 1000 });

    await expect(router.classify({
      ...base,
      text: "刚才那张图片里是什么？",
      mediaCandidates: [{
        messageId: 20, senderUserId: 42, type: "photo", sentAt: "2026-09-03T10:00:00.000Z",
        source: "current_user_recent",
      }],
      mediaPixelsProvided: false,
    }, "key")).resolves.toMatchObject({
      intent: "vision_qa", media_message_ids: [20], final_response: null, missingRequired: [],
    });
  });

  it("registers mia.system as a base module included once by the actual router prompt", () => {
    const basePrompt = PROMPT_LIBRARY.find((prompt) => prompt.id === "mia.system");
    const routerPrompt = PROMPT_LIBRARY.find((prompt) => prompt.id === "mia.intent-router");
    expect(basePrompt).toMatchObject({ kind: "base" });
    expect(routerPrompt).toMatchObject({ version: 5, kind: "composed", includes: ["mia.system"] });
    expect(routerPrompt?.text).toContain(basePrompt?.text ?? "missing");
  });
});
