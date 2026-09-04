import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import type { IntentRouter } from "../src/intent/router.js";
import { createLogger } from "../src/logger.js";
import { MediaStore } from "../src/media/store.js";
import { createBot } from "../src/telegram/bot.js";

const botInfo = {
  id: 100,
  is_bot: true,
  first_name: "Mia",
  username: "MiaAssistantBot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

function contexts() {
  return {
    upsertUser: vi.fn(),
    upsertChat: vi.fn(),
    upsertMember: vi.fn(),
    saveMessage: vi.fn(),
  };
}

function installApi(bot: ReturnType<typeof createBot>) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  bot.api.config.use((_previous, method, payload) => {
    const data = payload as unknown as Record<string, unknown>;
    calls.push({ method, payload: data });
    if (method === "sendMessage") {
      const chatId = Number(data.chat_id);
      return Promise.resolve({
        ok: true,
        result: {
          message_id: 900 + calls.length,
          date: 1_788_333_601,
          chat: chatId > 0
            ? { id: chatId, type: "private", first_name: "Liz" }
            : { id: chatId, type: "supergroup", title: "Mia group" },
          from: botInfo,
          text: typeof data.text === "string" ? data.text : "",
        },
      } as never);
    }
    if (method === "getFile") {
      return Promise.resolve({ ok: true, result: { file_id: "photo", file_unique_id: "photo-unique", file_path: "photos/source.jpg", file_size: 5 } } as never);
    }
    return Promise.resolve({ ok: true, result: true } as never);
  });
  return calls;
}

function update(chatId: number, caption: string | undefined, updateId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: 7,
      date: 1_788_333_600,
      chat: chatId > 0
        ? { id: chatId, type: "private", first_name: "Liz" }
        : { id: chatId, type: "supergroup", title: "Mia group" },
      from: { id: 42, is_bot: false, first_name: "Liz", language_code: "zh-CN" },
      photo: [{ file_id: "photo", file_unique_id: "photo-unique", width: 1024, height: 1024 }],
      ...(caption === undefined ? {} : { caption }),
      ...(chatId < 0 ? { caption_entities: [{ type: "mention", offset: 0, length: 16 }] } : {}),
    },
  };
}

describe("Telegram sticker intent", () => {
  let store: MediaStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  async function setup() {
    store = new MediaStore(":memory:");
    const classify = vi.fn().mockResolvedValue({
      intent: "sticker_create",
      confidence: 0.98,
      instruction: "做成点赞反应",
      media_source: "message",
      media_message_ids: [],
      image_options: { aspect_ratio: "1:1" },
      video_options: null,
      final_response: null,
      conversation_mode: "task",
      onboarding_opportunity: false,
      profile_updates: null,
      missingRequired: [],
    });
    const resolveAPIKey = vi.fn().mockResolvedValue("user-key");
    const getSnapshot = vi.fn().mockResolvedValue({
      apimasterUserId: "user-1",
      models: [],
      settings: { chatModel: null, visionModel: null, imageModel: "gpt-image-2", videoModel: null },
      unavailable: [],
    });
    const bot = createBot("123:test", {
      client: { resolveAPIKey } as unknown as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn(), getSnapshot },
      contexts: contexts(),
      router: { model: "gpt-5.4", classify } as unknown as IntentRouter,
      mediaStore: store,
      botToken: "123:test",
    });
    bot.botInfo = botInfo;
    const calls = installApi(bot);
    const source = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).jpeg().toBuffer();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(source, {
      headers: { "content-type": "image/jpeg" },
    })));
    return { bot, calls, classify, resolveAPIKey };
  }

  it("creates exactly one sticker-mode image job for an explicit private photo", async () => {
    const { bot, classify, resolveAPIKey } = await setup();

    await bot.handleUpdate(update(42, "给这个做个 TG 里能用的点赞反应", 1001) as never);

    const job = store?.getJobByIdempotencyKey("message:42:7");
    expect(classify).toHaveBeenCalledOnce();
    expect(resolveAPIKey).toHaveBeenCalledWith(42, "gpt-5.4");
    expect(resolveAPIKey).toHaveBeenCalledWith(42, "gpt-image-2");
    expect(job).toMatchObject({
      telegramUserId: 42,
      chatId: 42,
      type: "image_edit",
      status: "queued",
      options: { aspectRatio: "1:1", outputMode: "telegram_sticker", stickerTitle: "Liz | Mia" },
    });
    expect(job?.instruction).toContain("one polished Telegram sticker");
    expect(store?.listJobInputs(job?.id ?? 0)).toHaveLength(1);
  });

  it("uses /sticker as a deterministic shortcut without calling the router", async () => {
    const { bot, classify, resolveAPIKey } = await setup();

    await bot.handleUpdate(update(42, "/sticker", 1007) as never);

    const job = store?.getJobByIdempotencyKey("message:42:7");
    expect(classify).not.toHaveBeenCalled();
    expect(resolveAPIKey).toHaveBeenCalledWith(42, "gpt-image-2");
    expect(job).toMatchObject({
      telegramUserId: 42,
      chatId: 42,
      type: "image_edit",
      status: "queued",
      options: { aspectRatio: "1:1", outputMode: "telegram_sticker", stickerTitle: "Liz | Mia" },
    });
    expect(job?.instruction).toContain("one polished Telegram sticker");
  });

  it("passes a replied photo caption separately from the new sticker request", async () => {
    const { bot, classify } = await setup();
    const oldCaption = "提取图片里的龙猫，做一个比耶的表情";
    const currentText = "用这个图片里的龙猫做一个大哭的表情，做成 TG 贴纸";
    store?.saveTelegramMedia(42, null, {
      position: 0,
      messageId: 7,
      fileId: "photo",
      fileUniqueId: "photo-unique",
      type: "photo",
      mimeType: "image/jpeg",
      mediaGroupId: null,
    });
    classify.mockResolvedValueOnce({
      intent: "sticker_create", confidence: 0.99, instruction: "把龙猫做成大哭的表情", media_source: "reply",
      media_message_ids: [7], image_options: { aspect_ratio: "1:1" }, video_options: null,
      final_response: null, conversation_mode: "task", onboarding_opportunity: false, profile_updates: null,
      missingRequired: [],
    });

    await bot.handleUpdate({
      update_id: 1006,
      message: {
        message_id: 8,
        date: 1_788_333_700,
        chat: { id: 42, type: "private", first_name: "Liz" },
        from: { id: 42, is_bot: false, first_name: "Liz", language_code: "zh-CN" },
        text: currentText,
        reply_to_message: {
          message_id: 7,
          date: 1_788_333_600,
          chat: { id: 42, type: "private", first_name: "Liz" },
          from: { id: 42, is_bot: false, first_name: "Liz", language_code: "zh-CN" },
          photo: [{ file_id: "photo", file_unique_id: "photo-unique", width: 1024, height: 1024 }],
          caption: oldCaption,
        },
      },
    } as never);

    expect(classify.mock.calls[0]?.[0]).toMatchObject({
      text: currentText,
      repliedMessageText: oldCaption,
      replyToMessageId: 7,
      replyMediaCount: 1,
    });
    expect(store?.getJobByIdempotencyKey("message:42:8")?.instruction)
      .toContain("把龙猫做成大哭的表情");
  });

  it("does not create or classify a bare private photo", async () => {
    const { bot, classify, resolveAPIKey, calls } = await setup();

    await bot.handleUpdate(update(42, undefined, 1002) as never);

    expect(store?.getJobByIdempotencyKey("message:42:7")).toBeNull();
    expect(classify).not.toHaveBeenCalled();
    expect(resolveAPIKey).not.toHaveBeenCalled();
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text).toContain("分析这张图片");
  });

  it("keeps sticker generation disabled in groups", async () => {
    const { bot, classify, resolveAPIKey, calls } = await setup();

    await bot.handleUpdate(update(-1001, "@MiaAssistantBot 做贴纸", 1003) as never);

    expect(store?.getJobByIdempotencyKey("message:-1001:7")).toBeNull();
    expect(classify).toHaveBeenCalledOnce();
    expect(resolveAPIKey).toHaveBeenCalledWith(42, "gpt-5.4");
    expect(resolveAPIKey).not.toHaveBeenCalledWith(42, "gpt-image-2");
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text).toContain("只支持和 Mia 私聊");
  });

  it("keeps the sticker intent when the user supplies the image in the next message", async () => {
    const { bot, classify } = await setup();
    classify.mockReset()
      .mockResolvedValueOnce({
        intent: "sticker_create", confidence: 0.98, instruction: "做成无语反应", media_source: "none",
        media_message_ids: [], image_options: { aspect_ratio: "1:1" }, video_options: null,
        final_response: null, conversation_mode: "task", onboarding_opportunity: false, profile_updates: null,
        missingRequired: ["image"],
      })
      .mockResolvedValueOnce({
        intent: "chat", confidence: 0.99, instruction: "", media_source: "none",
        media_message_ids: [], image_options: null, video_options: null, final_response: "收到图片。",
        conversation_mode: "task", onboarding_opportunity: false, profile_updates: null, missingRequired: [],
      });

    await bot.handleUpdate({
      update_id: 1004,
      message: {
        message_id: 6,
        date: 1_788_333_500,
        chat: { id: 42, type: "private", first_name: "Liz" },
        from: { id: 42, is_bot: false, first_name: "Liz", language_code: "zh-CN" },
        text: "给我做个 TG 里能用的无语反应",
      },
    } as never);

    expect(store?.getPendingIntent({ telegramUserId: 42, chatId: 42, threadId: null })).toMatchObject({
      intent: "sticker_create",
      missingRequired: ["image"],
    });

    await bot.handleUpdate(update(42, undefined, 1005) as never);

    expect(classify).toHaveBeenCalledTimes(2);
    expect(store?.getJobByIdempotencyKey("message:42:7")).toMatchObject({
      type: "image_edit",
      options: { outputMode: "telegram_sticker" },
    });
    expect(store?.getPendingIntent({ telegramUserId: 42, chatId: 42, threadId: null })).toBeNull();
  });
});
