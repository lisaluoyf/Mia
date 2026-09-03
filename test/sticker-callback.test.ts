import { afterEach, describe, expect, it, vi } from "vitest";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import type { IntentRouter } from "../src/intent/router.js";
import { createLogger } from "../src/logger.js";
import { MediaStore } from "../src/media/store.js";
import { createBot } from "../src/telegram/bot.js";

const botInfo = {
  id: 100,
  is_bot: true,
  first_name: "Mia",
  username: "apimasterai_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

describe("sticker callbacks", () => {
  let store: MediaStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  function setup() {
    store = new MediaStore(":memory:");
    const claimed = store.claimJob({
      telegramUserId: 42,
      chatId: 42,
      threadId: null,
      type: "image_edit",
      idempotencyKey: "message:42:7",
      requestMessageId: 7,
      model: "gpt-image-2",
      instruction: "Create a one polished Telegram sticker",
      options: {
        aspectRatio: "1:1",
        locale: "zh-CN",
        outputMode: "telegram_sticker",
        stickerTitle: "Liz | Mia",
      },
    });
    if (claimed.outcome !== "created") throw new Error("Expected media job creation");
    store.transitionJob(claimed.job.id, ["queued"], "submitting");
    store.transitionJob(claimed.job.id, ["submitting"], "succeeded", {
      statusMessageId: 77,
      progress: 100,
      resultMimeType: "image/webp",
      resultTelegramFileId: "sticker-file",
      resultTelegramUniqueId: "sticker-unique",
    });
    store.saveTelegramMedia(42, null, {
      position: 0,
      messageId: 77,
      fileId: "sticker-file",
      fileUniqueId: "sticker-unique",
      type: "document",
      mimeType: "image/webp",
      mediaGroupId: null,
    });
    const classify = vi.fn();
    const bot = createBot("123:test", {
      client: { resolveAPIKey: vi.fn().mockResolvedValue("user-key") } as unknown as APIMasterClient,
      logger: createLogger("silent"),
      settings: {
        getPreferences: vi.fn().mockReturnValue({ imageModel: "gpt-image-2" }),
        getSnapshot: vi.fn().mockResolvedValue({
          apimasterUserId: "user-1",
          models: [],
          settings: { chatModel: null, visionModel: null, imageModel: "gpt-image-2", videoModel: null },
          unavailable: [],
        }),
      },
      contexts: {
        upsertUser: vi.fn(), upsertChat: vi.fn(), upsertMember: vi.fn(), saveMessage: vi.fn(),
      },
      mediaStore: store,
      router: { model: "gpt-5.4", classify } as unknown as IntentRouter,
      botToken: "123:test",
    });
    bot.botInfo = botInfo;
    let sentMessageId = 77;
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    bot.api.config.use((_previous, method, payload) => {
      calls.push({ method, payload });
      if (method === "sendMessage") {
        sentMessageId++;
        return Promise.resolve({
          ok: true,
          result: {
            message_id: sentMessageId,
            date: 1_788_333_600,
            chat: { id: 42, type: "private", first_name: "Liz" },
            from: botInfo,
            text: "text" in payload && typeof payload.text === "string" ? payload.text : "",
          },
        } as never);
      }
      return Promise.resolve({ ok: true, result: true } as never);
    });
    return { bot, calls, classify, job: claimed.job };
  }

  function callbackUpdate(jobId: number, action: "edit" | "again", updateId: number) {
    return {
      update_id: updateId,
      callback_query: {
        id: `callback-${action}`,
        from: { id: 42, is_bot: false, first_name: "Liz", language_code: "zh-CN" },
        message: {
          message_id: 77,
          date: 1_788_333_500,
          chat: { id: 42, type: "private", first_name: "Liz" },
          from: botInfo,
          sticker: { file_id: "sticker-file", file_unique_id: "sticker-unique", width: 512, height: 512, is_animated: false, is_video: false, type: "regular" },
        },
        chat_instance: "instance-1",
        data: `media:${jobId}:${action}`,
      },
    };
  }

  it("continues editing a sticker and preserves sticker output mode", async () => {
    const { bot, classify, job } = setup();
    await bot.handleUpdate(callbackUpdate(job.id, "edit", 9101) as never);

    expect(store?.getPendingIntent({ telegramUserId: 42, chatId: 42, threadId: null })).toMatchObject({
      missingRequired: ["instruction", "callback_reply", "sticker_output"],
      sourceMessageIds: [77, 78],
    });

    await bot.handleUpdate({
      update_id: 9102,
      message: {
        message_id: 79,
        date: 1_788_333_700,
        chat: { id: 42, type: "private", first_name: "Liz" },
        from: { id: 42, is_bot: false, first_name: "Liz", language_code: "zh-CN" },
        text: "眼镜保留，衣服换成红色",
        reply_to_message: {
          message_id: 78,
          date: 1_788_333_600,
          chat: { id: 42, type: "private", first_name: "Liz" },
          from: botInfo,
          text: "Liz: 请回复生成结果，并说明你想如何修改。",
        },
      },
    } as never);

    expect(classify).not.toHaveBeenCalled();
    const edited = store?.getJobByIdempotencyKey("message:42:79");
    expect(edited).toMatchObject({
      type: "image_edit",
      options: { outputMode: "telegram_sticker", stickerTitle: "Liz | Mia" },
    });
    expect(edited?.instruction).toContain("眼镜保留，衣服换成红色");
    expect(store?.listJobInputs(2)).toMatchObject([{ fileId: "sticker-file", messageId: 77 }]);
  });

  it("regenerates one more sticker with the original sticker settings", async () => {
    const { bot, job } = setup();
    await bot.handleUpdate(callbackUpdate(job.id, "again", 9103) as never);

    expect(store?.getJobByIdempotencyKey("callback:callback-again")).toMatchObject({
      status: "queued",
      instruction: job.instruction,
      options: {
        outputMode: "telegram_sticker",
        stickerTitle: "Liz | Mia",
        ephemeralStatus: true,
      },
    });
  });
});
