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
  it("reads the configured router model again for every request", async () => {
    let configuredModel = "router-a";
    const structuredResponse = vi.fn().mockResolvedValue(response({
      intent: "chat", confidence: 0.99, instruction: "", media_source: "none",
      image_options: null, video_options: null, final_response: "Hello",
      conversation_mode: "casual", onboarding_opportunity: false, profile_updates: null,
    }));
    const router = new IntentRouter({ structuredResponse }, { model: () => configuredModel, timeoutMs: 1000 });

    await router.classify(base, "key");
    configuredModel = "router-b";
    await router.classify(base, "key");

    expect(structuredResponse.mock.calls[0]?.[1]).toBe("router-a");
    expect(structuredResponse.mock.calls[1]?.[1]).toBe("router-b");
  });

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

  it("requires an image for edit, sticker, vision and image-to-video", () => {
    const shared = { confidence: 1, instruction: "do it", media_source: "none" as const, image_options: null, final_response: null };
    expect(validateIntentRequirements({ ...shared, intent: "image_edit", video_options: null }, base)).toContain("image");
    expect(validateIntentRequirements({ ...shared, intent: "sticker_create", instruction: "", video_options: null }, base))
      .toEqual(["image"]);
    expect(validateIntentRequirements({ ...shared, intent: "vision_qa", video_options: null }, base)).toContain("image");
    expect(validateIntentRequirements({ ...shared, intent: "video_generate", video_options: {
      mode: "image_to_video", duration_seconds: 4, aspect_ratio: "16:9", resolution: "768P", image_roles: [],
    } }, base)).toContain("image");
  });

  it("recognizes sticker creation as a first-class media intent", async () => {
    const structuredResponse = vi.fn().mockResolvedValue(response({
      intent: "sticker_create", confidence: 0.98, instruction: "做成一个无语反应，保留眼镜", media_source: "message",
      media_message_ids: [], image_options: { aspect_ratio: "1:1" }, video_options: null,
      final_response: null, conversation_mode: "task", onboarding_opportunity: false, profile_updates: null,
    }));
    const router = new IntentRouter({ structuredResponse }, { model: "gpt-5.4", timeoutMs: 1000 });

    await expect(router.classify({
      ...base,
      text: "给这个做个 TG 里能用的无语反应，眼镜别去掉",
      mediaType: "image",
      mediaCount: 1,
    }, "key", [{ bytes: new Uint8Array([1]), mimeType: "image/png", filename: "subject.png" }]))
      .resolves.toMatchObject({
        intent: "sticker_create",
        instruction: "做成一个无语反应，保留眼镜",
        missingRequired: [],
      });
    expect(JSON.stringify(structuredResponse.mock.calls[0]?.[4])).toContain("sticker_create");
  });

  it("separates the current request from the replied message caption", async () => {
    const structuredResponse = vi.fn().mockResolvedValue(response({
      intent: "sticker_create", confidence: 0.99, instruction: "把龙猫做成大哭的表情", media_source: "reply",
      media_message_ids: [7], image_options: { aspect_ratio: "1:1" }, video_options: null,
      final_response: null, conversation_mode: "task", onboarding_opportunity: false, profile_updates: null,
    }));
    const router = new IntentRouter({ structuredResponse }, { model: "gpt-5.4", timeoutMs: 1000 });

    await router.classify({
      ...base,
      text: "用这个图片里的龙猫做一个大哭的表情，做成 TG 贴纸",
      replyToMessageId: 7,
      repliedMessageText: "提取图片里的龙猫，做一个比耶的表情",
      replyMediaCount: 1,
      mediaCandidates: [{
        messageId: 7, senderUserId: 42, type: "photo", sentAt: "2026-09-03T14:00:00.000Z", source: "reply",
      }],
    }, "key");

    const messages = structuredResponse.mock.calls[0]?.[2] as Array<{ content: unknown }>;
    const metadata = JSON.parse(String(messages[1]?.content)) as {
      current_request_text: string;
      replied_message_text: string;
    };
    expect(metadata.current_request_text).toBe("用这个图片里的龙猫做一个大哭的表情，做成 TG 贴纸");
    expect(metadata.replied_message_text).toBe("提取图片里的龙猫，做一个比耶的表情");
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

  it("silently observes unrelated messages in selective follow-up mode", async () => {
    const structuredResponse = vi.fn().mockResolvedValue(response({
      should_respond: false,
      response_to_message_id: null,
      intent_hint: "chat",
      needs_web_search: false,
      confidence: 0.98,
      reason: "群成员之间的对话",
    }));
    const router = new IntentRouter({ structuredResponse }, { model: "gpt-5.4", timeoutMs: 1000 });

    await expect(router.classify({
      ...base,
      text: "[message_id=21 sender_user_id=7]\n好的，我和小王继续聊",
      participationMode: "selective",
      followUpBatchMessageIds: [21],
    }, "public-key")).resolves.toMatchObject({
      should_respond: false,
      response_to_message_id: null,
    });
    const messages = structuredResponse.mock.calls[0]?.[2] as Array<{ content: unknown }>;
    const payload = JSON.parse(String(messages[1]?.content)) as Record<string, unknown>;
    expect(payload.participation_mode).toBe("selective");
    expect(payload.follow_up_batch_message_ids).toEqual([21]);
  });

  it("answers an obvious short follow-up without spending a separate model call on participation", async () => {
    const followUpReply = {
      version: 1 as const,
      title: null,
      blocks: [{
        type: "paragraph" as const,
        heading: null,
        emoji: null,
        text: "后天北京预计多云。",
        items: [],
        ordered: false,
        language: null,
      }],
      actions: [],
    };
    const structuredResponse = vi.fn().mockResolvedValue(response(followUpReply, {
      callCount: 1,
      queries: ["北京后天天气"],
      sources: [],
    }));
    const router = new IntentRouter({ structuredResponse }, { model: "gpt-5.4", timeoutMs: 30_000 });

    const result = await router.classify({
      ...base,
      text: "[message_id=172 sender_user_id=5701793686]\n后天呢？",
      participationMode: "selective",
      followUpBatchMessageIds: [172],
      followUpContext: {
        scopeType: "group",
        chatId: -1001964722014,
        threadId: null,
        awakenedByUserId: 5701793686,
        lastHandledAt: "2026-09-03T14:48:41.795Z",
      },
      recentMessages: [
        { role: "user", messageId: 170, senderUserId: 5701793686, text: "北京明天天气查一下。" },
        { role: "assistant", messageId: 171, senderUserId: 100, text: "明天北京有雨。" },
        { role: "user", messageId: 172, senderUserId: 5701793686, text: "后天呢？" },
      ],
    }, "public-follow-up-key");

    expect(result).toMatchObject({
      should_respond: true,
      response_to_message_id: 172,
      reply: followUpReply,
      webSearch: { callCount: 1, queries: ["北京后天天气"] },
    });
    expect(structuredResponse).toHaveBeenCalledTimes(1);
    expect(structuredResponse.mock.calls[0]?.[0]).toBe("public-follow-up-key");
    expect(structuredResponse.mock.calls[0]?.[3]).toBe("mia_follow_up_chat_response");
    expect(structuredResponse.mock.calls[0]?.[5]).toBe(45_000);
  });

  it("uses model participation before routing the awakened user's recent image edit", async () => {
    const instruction = "帮我把脸改得看起来没那么像 AI，同时做一个反射效果。另外，现在这个 logo 在屏幕上不太显眼，也请加上反射，让脸看起来更自然。";
    const structuredChat = vi.fn()
      .mockResolvedValueOnce({
        should_respond: true,
        response_to_message_id: 192,
        intent_hint: "media_or_summary",
        needs_web_search: false,
        confidence: 0.99,
        reason: "explicit_image_edit_request",
      })
      .mockResolvedValueOnce({
        intent: "image_edit",
        should_respond: true,
        response_to_message_id: 192,
        confidence: 0.99,
        instruction,
        media_source: "context",
        media_message_ids: [191],
        image_options: { aspect_ratio: null },
        video_options: null,
        reply: null,
        conversation_mode: "task",
        onboarding_opportunity: false,
        profile_updates: null,
      });
    const structuredResponse = vi.fn();
    const router = new IntentRouter({ structuredResponse, structuredChat }, { model: "gpt-5.4", timeoutMs: 30_000 });

    const result = await router.classify({
      ...base,
      text: `[message_id=192 sender_user_id=42]\n${instruction}`,
      participationMode: "selective",
      followUpBatchMessageIds: [192],
      followUpContext: {
        scopeType: "group",
        chatId: -1001964722014,
        threadId: null,
        awakenedByUserId: 42,
        lastHandledAt: "2026-09-04T04:23:46.408Z",
      },
      recentMessages: [
        { role: "assistant", messageId: 190, senderUserId: 100, text: "可以，发一张参考图。", sentAt: "2026-09-04T04:23:46.408Z" },
        { role: "user", messageId: 191, senderUserId: 42, text: "[photo]", contentType: "photo", sentAt: "2026-09-04T04:24:28.000Z" },
        { role: "user", messageId: 192, senderUserId: 42, text: instruction, contentType: "text", sentAt: "2026-09-04T04:24:49.000Z" },
      ],
      mediaCandidates: [{
        messageId: 191,
        senderUserId: 42,
        type: "photo",
        sentAt: "2026-09-04T04:24:28.000Z",
        source: "current_user_recent",
      }],
    }, "public-follow-up-key");

    expect(result).toMatchObject({
      intent: "image_edit",
      should_respond: true,
      response_to_message_id: 192,
      media_message_ids: [191],
      participationSource: "model",
      participationReason: "explicit_image_edit_request",
    });
    expect(structuredResponse).not.toHaveBeenCalled();
    expect(structuredChat).toHaveBeenCalledTimes(2);
    expect(structuredChat.mock.calls[0]?.[0]).toBe("public-follow-up-key");
    expect(structuredChat.mock.calls[0]?.[3]).toBe("mia_follow_up_participation");
    expect(structuredChat.mock.calls[1]?.[3]).toBe("mia_media_intent");
  });

  it("makes a model-confirmed image correction visible when full media routing fails", async () => {
    const structuredChat = vi.fn()
      .mockResolvedValueOnce({
        should_respond: true,
        response_to_message_id: 193,
        intent_hint: "media_or_summary",
        needs_web_search: false,
        confidence: 0.99,
        reason: "explicit_image_edit_correction",
      })
      .mockRejectedValueOnce(new Error("timeout"));
    const structuredResponse = vi.fn();
    const router = new IntentRouter({ structuredResponse, structuredChat }, { model: "gpt-5.4", timeoutMs: 30_000 });

    const result = await router.classify({
      ...base,
      text: "[message_id=193 sender_user_id=42]\n反色",
      participationMode: "selective",
      followUpBatchMessageIds: [193],
      followUpContext: {
        scopeType: "group",
        chatId: -1001964722014,
        threadId: null,
        awakenedByUserId: 42,
        lastHandledAt: "2026-09-04T04:23:46.408Z",
      },
      recentMessages: [
        { role: "user", messageId: 191, senderUserId: 42, text: "[photo]", contentType: "photo", sentAt: "2026-09-04T04:24:28.000Z" },
        { role: "user", messageId: 192, senderUserId: 42, text: "把脸修自然一点", contentType: "text", sentAt: "2026-09-04T04:24:49.000Z" },
        { role: "user", messageId: 193, senderUserId: 42, text: "反色", contentType: "text", sentAt: "2026-09-04T04:24:56.000Z" },
      ],
      mediaCandidates: [{
        messageId: 191,
        senderUserId: 42,
        type: "photo",
        sentAt: "2026-09-04T04:24:28.000Z",
        source: "current_user_recent",
      }],
    }, "public-follow-up-key");

    expect(result).toMatchObject({
      intent: "chat",
      should_respond: true,
      response_to_message_id: 193,
      fallbackReason: "response_fallback",
      participationSource: "model",
      participationReason: "explicit_image_edit_correction",
    });
    expect(result.reply?.blocks[0]?.text).toContain("图片处理请求");
    expect(structuredResponse).not.toHaveBeenCalled();
    expect(structuredChat).toHaveBeenCalledTimes(2);
    expect(structuredChat.mock.calls[0]?.[3]).toBe("mia_follow_up_participation");
    expect(structuredChat.mock.calls[1]?.[3]).toBe("mia_media_intent");
  });

  it("lets model participation keep another group member's image comment silent", async () => {
    const structuredChat = vi.fn().mockResolvedValue({
      should_respond: false,
      response_to_message_id: null,
      intent_hint: "chat",
      needs_web_search: false,
      confidence: 0.98,
      reason: "another_member_comment",
    });
    const structuredResponse = vi.fn();
    const router = new IntentRouter({ structuredResponse, structuredChat }, { model: "gpt-5.4", timeoutMs: 30_000 });

    await router.classify({
      ...base,
      text: "[message_id=193 sender_user_id=43]\n把这张图反色",
      participationMode: "selective",
      followUpBatchMessageIds: [193],
      followUpContext: {
        scopeType: "group",
        chatId: -1001964722014,
        threadId: null,
        awakenedByUserId: 42,
        lastHandledAt: "2026-09-04T04:23:46.408Z",
      },
      recentMessages: [
        { role: "user", messageId: 191, senderUserId: 43, text: "[photo]", contentType: "photo", sentAt: "2026-09-04T04:24:28.000Z" },
        { role: "user", messageId: 193, senderUserId: 43, text: "把这张图反色", contentType: "text", sentAt: "2026-09-04T04:24:56.000Z" },
      ],
    }, "public-follow-up-key");

    expect(structuredResponse).not.toHaveBeenCalled();
    expect(structuredChat).toHaveBeenCalledOnce();
    expect(structuredChat.mock.calls[0]?.[3]).toBe("mia_follow_up_participation");
  });

  it("keeps unrelated chat silent after the lightweight public decision", async () => {
    const structuredResponse = vi.fn().mockResolvedValue(response({
      should_respond: false,
      response_to_message_id: null,
      intent_hint: "chat",
      needs_web_search: false,
      confidence: 0.97,
      reason: "群成员之间的安排",
    }));
    const router = new IntentRouter({ structuredResponse }, { model: "gpt-5.4", timeoutMs: 30_000 });

    await expect(router.classify({
      ...base,
      text: "[message_id=173 sender_user_id=7]\n小王，我们明早十点开会",
      participationMode: "selective",
      followUpBatchMessageIds: [173],
    }, "public-follow-up-key")).resolves.toMatchObject({
      should_respond: false,
      response_to_message_id: null,
      confidence: 0.97,
    });
    expect(structuredResponse).toHaveBeenCalledOnce();
    expect(structuredResponse.mock.calls[0]?.[3]).toBe("mia_follow_up_participation");
    expect(structuredResponse.mock.calls[0]?.[6]).toEqual({ webSearch: false });
  });

  it("returns a visible safe reply when a confirmed follow-up answer times out", async () => {
    const structuredResponse = vi.fn().mockRejectedValue(new Error("timeout"));
    const router = new IntentRouter({ structuredResponse }, { model: "gpt-5.4", timeoutMs: 30_000 });

    const result = await router.classify({
      ...base,
      text: "后天呢？",
      participationMode: "selective",
      followUpBatchMessageIds: [172],
      followUpContext: {
        scopeType: "group",
        chatId: -1001,
        threadId: null,
        awakenedByUserId: 42,
        lastHandledAt: "2026-09-03T10:00:00.000Z",
      },
      recentMessages: [
        { role: "assistant", messageId: 171, senderUserId: 100, text: "北京明天天气有雨。" },
        { role: "user", messageId: 172, senderUserId: 42, text: "后天呢？" },
      ],
    }, "public-follow-up-key");
    expect(result).toMatchObject({
      should_respond: true,
      response_to_message_id: 172,
      fallbackReason: "response_fallback",
    });
    expect(result.reply?.blocks[0]?.text).toContain("公共模型");
    expect(structuredResponse).toHaveBeenCalledOnce();
  });

  it("stays silent when the lightweight public participation decision fails", async () => {
    const structuredResponse = vi.fn().mockRejectedValue(new Error("timeout"));
    const router = new IntentRouter({ structuredResponse }, { model: "gpt-5.4", timeoutMs: 30_000 });

    await expect(router.classify({
      ...base,
      text: "请评估这份方案",
      participationMode: "selective",
      followUpBatchMessageIds: [172],
    }, "public-follow-up-key")).resolves.toMatchObject({
      should_respond: false,
      fallbackReason: "router_unavailable",
    });
  });

  it("requires selective replies to target a real message in the current batch", async () => {
    const validReply = {
      version: 1 as const,
      title: null,
      blocks: [{ type: "paragraph" as const, heading: null, emoji: null, text: "可以，我继续处理。", items: [], ordered: false, language: null }],
      actions: [],
    };
    const structuredResponse = vi.fn()
      .mockResolvedValueOnce(response({
        should_respond: true, response_to_message_id: 22, intent_hint: "media_or_summary",
        needs_web_search: false, confidence: 0.99, reason: "明确请求 Mia 继续媒体任务",
      }))
      .mockResolvedValueOnce(response({
        intent: "chat", should_respond: true, response_to_message_id: 22,
        confidence: 0.99, instruction: "继续处理", media_source: "none", media_message_ids: [],
        image_options: null, video_options: null, reply: validReply,
        conversation_mode: "task", onboarding_opportunity: false, profile_updates: null,
      }))
      .mockResolvedValueOnce(response({
        should_respond: true, response_to_message_id: 999, intent_hint: "chat",
        needs_web_search: false, confidence: 0.99, reason: "无效目标",
      }));
    const router = new IntentRouter({ structuredResponse }, { model: "gpt-5.4", timeoutMs: 1000 });
    const input = {
      ...base,
      participationMode: "selective" as const,
      followUpBatchMessageIds: [21, 22],
    };

    await expect(router.classify(input, "public-key")).resolves.toMatchObject({
      should_respond: true,
      response_to_message_id: 22,
    });
    await expect(router.classify(input, "public-key")).resolves.toMatchObject({
      should_respond: false,
      response_to_message_id: null,
      fallbackReason: "invalid_output",
    });
  });

  it("keeps router failures silent in selective mode while preserving direct fallback", async () => {
    const router = new IntentRouter({ structuredResponse: vi.fn().mockRejectedValue(new Error("timeout")) }, {
      model: "gpt-5.4", timeoutMs: 1000,
    });
    await expect(router.classify({
      ...base,
      participationMode: "selective",
      followUpBatchMessageIds: [21],
    }, "public-key")).resolves.toMatchObject({ should_respond: false, fallbackReason: "router_unavailable" });
    await expect(router.classify(base, "user-key")).resolves.toMatchObject({
      should_respond: true,
      fallbackReason: "router_unavailable",
    });
  });

  it("registers the concise base prompt in each composed chat prompt", () => {
    const basePrompt = PROMPT_LIBRARY.find((prompt) => prompt.id === "mia.system");
    const routerPrompt = PROMPT_LIBRARY.find((prompt) => prompt.id === "mia.intent-router");
    const participationPrompt = PROMPT_LIBRARY.find((prompt) => prompt.id === "mia.follow-up-participation");
    const followUpPrompt = PROMPT_LIBRARY.find((prompt) => prompt.id === "mia.follow-up-chat");
    expect(basePrompt).toMatchObject({ version: 6, kind: "base" });
    expect(basePrompt?.text).toContain("开门见山，优先给出结论");
    expect(basePrompt?.text).toContain("默认不超过 200 字或 3 个要点");
    expect(routerPrompt).toMatchObject({
      version: 15,
      kind: "composed",
      includes: ["mia.system"],
    });
    expect(routerPrompt?.text).toContain(basePrompt?.text ?? "missing");
    expect(routerPrompt?.text).not.toContain("信息较多时");
    expect(routerPrompt?.text).not.toContain("list 用于并列重点");
    expect(routerPrompt?.text).toContain("不得把段落正文放进 paragraph.items");
    expect(participationPrompt).toMatchObject({ version: 3 });
    expect(participationPrompt?.text).toContain("只有存在这类证据时才允许 should_respond=true");
    expect(participationPrompt?.text).toContain("包含附件或描述附件，都不能单独构成介入理由");
    expect(participationPrompt?.text).toContain("不要从图片、视频、文件的存在或其文字描述推断");
    expect(participationPrompt?.text).not.toContain("简单附和或感谢、表情式回复");
    expect(followUpPrompt).toMatchObject({
      version: 9,
      kind: "composed",
      includes: ["mia.system"],
    });
    expect(followUpPrompt?.text).toContain(basePrompt?.text ?? "missing");
  });
});
