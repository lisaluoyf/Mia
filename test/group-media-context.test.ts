import { afterEach, describe, expect, it, vi } from "vitest";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import type { IntentRouter } from "../src/intent/router.js";
import { createLogger } from "../src/logger.js";
import { MediaStore } from "../src/media/store.js";
import { ContextStore } from "../src/storage/store.js";
import { createBot } from "../src/telegram/bot.js";

describe("group media context routing", () => {
  let contexts: ContextStore | undefined;
  let mediaStore: MediaStore | undefined;

  afterEach(() => {
    contexts?.close();
    mediaStore?.close();
    vi.unstubAllGlobals();
  });

  it("binds a nearby Mia-generated Topic image when the user says to use this image", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    contexts = new ContextStore(":memory:");
    mediaStore = new MediaStore(":memory:");
    contexts.upsertUser({
      telegramUserId: 100, firstName: "Mia", lastName: null, username: "apimasterai_bot",
      languageCode: null, isBot: true,
    });
    contexts.upsertChat({
      chatId: -1001, type: "supergroup", title: "Bot 玩家", username: null,
      description: null, isForum: true,
    });
    contexts.saveMessage({
      chatId: -1001, messageId: 10, threadId: 12, senderUserId: 100, senderChatId: null,
      replyToMessageId: 9, contentType: "photo", text: null, caption: "图片已生成",
      entitiesJson: null, mediaFileId: "generated-file", mediaUniqueId: "generated-unique",
      sentAt: new Date(nowSeconds * 1_000).toISOString(), editedAt: null,
    });
    mediaStore.saveTelegramMedia(-1001, 12, {
      position: 0, messageId: 10, fileId: "generated-file", fileUniqueId: "generated-unique",
      type: "photo", mimeType: "image/png", mediaGroupId: null,
    });
    const classify = vi.fn().mockResolvedValue({
      intent: "video_generate", confidence: 0.99, instruction: "龙猫收衣服后去切土豆", media_source: "context",
      media_message_ids: [10], image_options: null,
      video_options: {
        mode: "image_to_video", duration_seconds: 6, aspect_ratio: "16:9", resolution: "768P",
        image_roles: ["first_frame"],
      },
      final_response: null, conversation_mode: "task", onboarding_opportunity: false, profile_updates: null,
      missingRequired: [],
    });
    const resolveAPIKey = vi.fn().mockResolvedValue("user-key");
    const bot = createBot("123:test", {
      client: { resolveAPIKey } as unknown as APIMasterClient,
      logger: createLogger("silent"),
      settings: {
        getPreferences: vi.fn().mockReturnValue({ videoModel: "minimax-h3" }),
        getSnapshot: vi.fn().mockResolvedValue(null),
      },
      contexts,
      mediaStore,
      router: { model: "gpt-5.4", classify } as unknown as IntentRouter,
      botToken: "123:test",
    });
    const botInfo = {
      id: 100, is_bot: true, first_name: "Mia", username: "apimasterai_bot",
      can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
      can_connect_to_business: false, has_main_web_app: false,
    };
    bot.botInfo = botInfo;
    const apiCalls: string[] = [];
    bot.api.config.use((_previous, method, payload) => {
      const safePayload = payload as unknown as Record<string, unknown>;
      apiCalls.push(method);
      if (method === "sendMessage") return Promise.resolve({
        ok: true,
        result: {
          message_id: 100, date: 1_788_333_610,
          chat: { id: Number(safePayload.chat_id), type: "supergroup", title: "Bot 玩家", is_forum: true },
          from: botInfo, text: typeof safePayload.text === "string" ? safePayload.text : "",
        },
      } as never);
      return Promise.resolve({ ok: true, result: true } as never);
    });

    await bot.handleUpdate({
      update_id: 2001,
      message: {
        message_id: 11, message_thread_id: 12, date: nowSeconds + 7,
        chat: { id: -1001, type: "supergroup", title: "Bot 玩家", is_forum: true },
        from: { id: 42, is_bot: false, first_name: "Liz", language_code: "zh-CN" },
        text: "@apimasterai_bot 基于这个图片做一个 6 秒视频",
        entities: [{ type: "mention", offset: 0, length: 16 }],
      },
    } as never);

    expect(classify).toHaveBeenCalledOnce();
    expect(classify.mock.calls[0]?.[0]).toMatchObject({
      mediaPixelsProvided: false,
      mediaCandidates: [{ messageId: 10, senderUserId: 100, source: "topic_recent" }],
    });
    expect(apiCalls).not.toContain("getFile");
    const draft = mediaStore.getJobByIdempotencyKey("message:-1001:11");
    expect(draft).toMatchObject({ type: "video_generate", status: "draft", threadId: 12 });
    expect(draft && mediaStore.listJobInputs(draft.id)).toMatchObject([{ messageId: 10, fileId: "generated-file" }]);
  });

  it("restores a replied-to Mia-generated image before routing a group video request", async () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    contexts = new ContextStore(":memory:");
    mediaStore = new MediaStore(":memory:");
    mediaStore.saveTelegramMedia(-1001, 12, {
      position: 0,
      messageId: 77,
      fileId: "generated-file",
      fileUniqueId: "generated-unique",
      type: "photo",
      mimeType: "image/png",
      mediaGroupId: null,
    });
    const classify = vi.fn().mockResolvedValue({
      intent: "video_generate", confidence: 0.99, instruction: "让这张图变成黑洞，再变成白洞",
      media_source: "reply", media_message_ids: [77], image_options: null,
      video_options: {
        mode: "image_to_video", duration_seconds: 15, aspect_ratio: "16:9", resolution: "768P",
        image_roles: ["first_frame"],
      },
      final_response: null, conversation_mode: "task", onboarding_opportunity: false, profile_updates: null,
      missingRequired: [],
    });
    const resolveAPIKey = vi.fn().mockResolvedValue("user-key");
    const getPreferences = vi.fn().mockReturnValue({ videoModel: "minimax-h3" });
    const bot = createBot("123:test", {
      client: { resolveAPIKey } as unknown as APIMasterClient,
      logger: createLogger("silent"),
      settings: {
        getPreferences,
        getSnapshot: vi.fn().mockResolvedValue(null),
      },
      contexts,
      mediaStore,
      router: { model: "gpt-5.4", classify } as unknown as IntentRouter,
      botToken: "123:test",
    });
    const botInfo = {
      id: 100, is_bot: true, first_name: "Mia", username: "apimasterai_bot",
      can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
      can_connect_to_business: false, has_main_web_app: false,
    };
    bot.botInfo = botInfo;
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(png, {
      headers: { "content-type": "image/png" },
    })));
    bot.api.config.use((_previous, method) => {
      if (method === "getFile") return Promise.resolve({
        ok: true,
        result: {
          file_id: "generated-file",
          file_unique_id: "generated-unique",
          file_size: png.length,
          file_path: "photos/generated.png",
        },
      } as never);
      if (method === "sendMessage") return Promise.resolve({
        ok: true,
        result: {
          message_id: 79, date: nowSeconds,
          chat: { id: -1001, type: "supergroup", title: "Mia builders", is_forum: true },
          from: botInfo,
          text: "视频草稿",
        },
      } as never);
      return Promise.resolve({ ok: true, result: true } as never);
    });

    await bot.handleUpdate({
      update_id: 2003,
      message: {
        message_id: 78, message_thread_id: 12, date: nowSeconds,
        chat: { id: -1001, type: "supergroup", title: "Mia builders", is_forum: true },
        from: { id: 42, is_bot: false, first_name: "Liz", language_code: "zh-CN" },
        text: "就是这个，生成 15 秒 16:9 视频",
        reply_to_message: {
          message_id: 77, message_thread_id: 12, date: nowSeconds - 30,
          chat: { id: -1001, type: "supergroup", title: "Mia builders", is_forum: true },
          from: botInfo,
          photo: [{ file_id: "generated-file", file_unique_id: "generated-unique", width: 1024, height: 1024 }],
          caption: "图片已生成",
        },
      },
    } as never);

    expect(contexts.getMessage(-1001, 77)).toMatchObject({
      senderUserId: 100,
      contentType: "photo",
      mediaFileId: "generated-file",
    });
    expect(classify).toHaveBeenCalledOnce();
    expect(classify.mock.calls[0]?.[0]).toMatchObject({
      replyMediaCount: 1,
      replyToMessageId: 77,
      mediaCandidates: [{ messageId: 77, senderUserId: 100, source: "reply" }],
    });
    const draft = mediaStore.getJobByIdempotencyKey("message:-1001:78");
    expect(draft).toMatchObject({ type: "video_generate", status: "draft", threadId: 12 });
    expect(draft && mediaStore.listJobInputs(draft.id)).toMatchObject([
      { messageId: 77, fileId: "generated-file" },
    ]);
  });
});
