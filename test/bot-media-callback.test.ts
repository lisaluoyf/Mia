import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputFile } from "grammy";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import { createLogger } from "../src/logger.js";
import { MediaStore } from "../src/media/store.js";
import type { IntentRouter } from "../src/intent/router.js";
import { createBot } from "../src/telegram/bot.js";

describe("Telegram media callbacks", () => {
  let store: MediaStore | undefined;
  let resultDirectory: string | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    if (resultDirectory) rmSync(resultDirectory, { recursive: true, force: true });
    resultDirectory = undefined;
  });

  it("sends the locally stored original as a Telegram document", async () => {
    resultDirectory = mkdtempSync(join(tmpdir(), "mia-download-callback-"));
    store = new MediaStore(":memory:", { resultDirectory });
    const claimed = store.claimJob({
      telegramUserId: 42,
      chatId: 42,
      threadId: null,
      type: "image_generate",
      idempotencyKey: "message:42:70",
      requestMessageId: 70,
      model: "gpt-image-2",
      instruction: "A moonlit portrait",
      options: { locale: "zh-CN" },
    });
    if (claimed.outcome !== "created") throw new Error("Expected media job creation");
    store.transitionJob(claimed.job.id, ["queued"], "submitting");
    store.transitionJob(claimed.job.id, ["submitting"], "submitted", { upstreamTaskId: "task-1" });
    store.transitionJob(claimed.job.id, ["submitted"], "succeeded", {
      statusMessageId: 77,
      progress: 100,
      resultUrl: "https://media.example/result.png",
      resultMimeType: "image/png",
    });
    store.saveLocalResult(claimed.job.id, Buffer.from("original-image-bytes"));

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
    const bot = createBot("123:test", {
      client: {
        resolveAPIKey: vi.fn(),
        getContent: vi.fn(),
      } as unknown as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn() },
      contexts: {
        upsertUser: vi.fn(),
        upsertChat: vi.fn(),
        upsertMember: vi.fn(),
        saveMessage: vi.fn(),
      },
      mediaStore: store,
      botToken: "123:test",
      resultMaxBytes: 10_000_000,
    });
    bot.botInfo = botInfo;
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    bot.api.config.use((_previous, method, payload) => {
      calls.push({ method, payload });
      return Promise.resolve({ ok: true, result: true } as never);
    });

    await bot.handleUpdate({
      update_id: 9004,
      callback_query: {
        id: "callback-download-1",
        from: {
          id: 42,
          is_bot: false,
          first_name: "Liz",
          language_code: "zh-CN",
        },
        message: {
          message_id: 77,
          date: 1_788_333_500,
          chat: { id: 42, type: "private", first_name: "Liz" },
          from: botInfo,
          photo: [{ file_id: "generated-photo", file_unique_id: "generated-unique", width: 1024, height: 1024 }],
          caption: "图片已生成",
        },
        chat_instance: "instance-1",
        data: `media:${claimed.job.id}:download`,
      },
    } as never);

    expect(calls.map(({ method }) => method)).toEqual(["answerCallbackQuery", "sendDocument"]);
    expect(calls[0]).toEqual({
      method: "answerCallbackQuery",
      payload: { callback_query_id: "callback-download-1" },
    });
    expect(calls[1]).toMatchObject({
      method: "sendDocument",
      payload: {
        chat_id: 42,
      },
    });
    expect(calls[1]?.payload.document).toBeInstanceOf(InputFile);
    expect(calls[1]?.payload.document).toMatchObject({
      filename: "mia-image.png",
      fileData: Buffer.from("original-image-bytes"),
    });
  });

  it("opens a selective force-reply prompt bound to the generated image", async () => {
    store = new MediaStore(":memory:");
    const claimed = store.claimJob({
      telegramUserId: 42,
      chatId: -1001,
      threadId: 12,
      type: "image_generate",
      idempotencyKey: "message:-1001:70",
      requestMessageId: 70,
      model: "gpt-image-2",
      instruction: "A moonlit portrait",
      options: { aspectRatio: "1:1", resolution: "1K", locale: "zh-CN" },
    });
    if (claimed.outcome !== "created") throw new Error("Expected media job creation");
    store.transitionJob(claimed.job.id, ["queued"], "submitting");
    store.transitionJob(claimed.job.id, ["submitting"], "submitted", { upstreamTaskId: "task-1" });
    store.transitionJob(claimed.job.id, ["submitted"], "succeeded", {
      statusMessageId: 77,
      progress: 100,
      resultUrl: "https://media.example/result.png",
      resultMimeType: "image/png",
      resultTelegramFileId: "generated-photo",
      resultTelegramUniqueId: "generated-unique",
    });
    store.saveTelegramMedia(-1001, 12, {
      position: 0,
      messageId: 77,
      fileId: "generated-photo",
      fileUniqueId: "generated-unique",
      type: "photo",
      mimeType: "image/png",
      mediaGroupId: null,
    });

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
    const classify = vi.fn();
    const getPreferences = vi.fn().mockReturnValue({ imageModel: "gpt-image-2" });
    const bot = createBot("123:test", {
      client: { resolveAPIKey: vi.fn().mockResolvedValue("user-key") } as unknown as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences },
      contexts: {
        upsertUser: vi.fn(),
        upsertChat: vi.fn(),
        upsertMember: vi.fn(),
        saveMessage: vi.fn(),
      },
      mediaStore: store,
      router: { model: "gpt-5.4", classify } as unknown as IntentRouter,
      botToken: "123:test",
      resultMaxBytes: 10_000_000,
    });
    bot.botInfo = botInfo;
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    let sentMessageId = 77;
    bot.api.config.use((_previous, method, payload) => {
      calls.push({ method, payload });
      if (method === "sendMessage") {
        const text = "text" in payload && typeof payload.text === "string" ? payload.text : "";
        sentMessageId++;
        return Promise.resolve({
          ok: true,
          result: {
            message_id: sentMessageId,
            date: 1_788_333_600,
            chat: { id: -1001, type: "supergroup", title: "Mia builders", is_forum: true },
            from: botInfo,
            text,
          },
        } as never);
      }
      return Promise.resolve({ ok: true, result: true } as never);
    });

    await bot.handleUpdate({
      update_id: 9005,
      callback_query: {
        id: "callback-edit-1",
        from: {
          id: 42,
          is_bot: false,
          first_name: "Liz",
          username: "liz",
          language_code: "zh-CN",
        },
        message: {
          message_id: 77,
          message_thread_id: 12,
          date: 1_788_333_500,
          chat: { id: -1001, type: "supergroup", title: "Mia builders", is_forum: true },
          from: botInfo,
          photo: [{ file_id: "generated-photo", file_unique_id: "generated-unique", width: 1024, height: 1024 }],
          caption: "图片已生成",
        },
        chat_instance: "instance-1",
        data: `media:${claimed.job.id}:edit`,
      },
    } as never);

    expect(calls[0]).toMatchObject({
      method: "answerCallbackQuery",
      payload: { callback_query_id: "callback-edit-1" },
    });
    expect(calls[1]).toMatchObject({
      method: "sendMessage",
      payload: {
        chat_id: -1001,
        text: "Liz: 请回复生成结果，并说明你想如何修改。",
        message_thread_id: 12,
        reply_parameters: { message_id: 77, allow_sending_without_reply: true },
        entities: [{
          type: "text_mention",
          offset: 0,
          length: 3,
          user: {
            id: 42,
            is_bot: false,
            first_name: "Liz",
            username: "liz",
            language_code: "zh-CN",
          },
        }],
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: "继续修改",
        },
      },
    });
    expect(store.getPendingIntent({ telegramUserId: 42, chatId: -1001, threadId: 12 })).toMatchObject({
      intent: "image_edit",
      missingRequired: ["instruction", "callback_reply"],
      sourceMessageIds: [77, 78],
      slots: { intent: "image_edit", media_source: "reply" },
    });

    await bot.handleUpdate({
      update_id: 9006,
      message: {
        message_id: 79,
        message_thread_id: 12,
        date: 1_788_333_700,
        chat: { id: -1001, type: "supergroup", title: "Mia builders", is_forum: true },
        from: {
          id: 42,
          is_bot: false,
          first_name: "Liz",
          username: "liz",
          language_code: "zh-CN",
        },
        text: "把背景改成雪天",
        reply_to_message: {
          message_id: 78,
          message_thread_id: 12,
          date: 1_788_333_600,
          chat: { id: -1001, type: "supergroup", title: "Mia builders", is_forum: true },
          from: botInfo,
          text: "Liz: 请回复生成结果，并说明你想如何修改。",
        },
      },
    } as never);

    expect(classify).not.toHaveBeenCalled();
    expect(store.getJobByIdempotencyKey("message:-1001:79")).toMatchObject({
      type: "image_edit",
      instruction: "把背景改成雪天",
      telegramUserId: 42,
      chatId: -1001,
      threadId: 12,
    });
    expect(store.listJobInputs(2)).toMatchObject([{
      fileId: "generated-photo",
      messageId: 77,
      position: 0,
    }]);
    expect(store.getPendingIntent({ telegramUserId: 42, chatId: -1001, threadId: 12 })).toBeNull();
  });

  it("shows an in-thread progress message without a queued callback toast when regenerating", async () => {
    store = new MediaStore(":memory:");
    const claimed = store.claimJob({
      telegramUserId: 42,
      chatId: -1001,
      threadId: 12,
      type: "image_generate",
      idempotencyKey: "message:-1001:70",
      requestMessageId: 70,
      model: "gpt-image-2",
      instruction: "A moonlit portrait",
      options: { aspectRatio: "1:1", resolution: "1K", locale: "zh-CN" },
    });
    if (claimed.outcome !== "created") throw new Error("Expected media job creation");
    store.transitionJob(claimed.job.id, ["queued"], "submitting");
    store.transitionJob(claimed.job.id, ["submitting"], "submitted", { upstreamTaskId: "task-1" });
    store.transitionJob(claimed.job.id, ["submitted"], "succeeded", {
      statusMessageId: 77,
      progress: 100,
      resultUrl: "https://media.example/result.png",
      resultMimeType: "image/png",
      resultTelegramFileId: "generated-photo",
      resultTelegramUniqueId: "generated-unique",
    });

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
    const bot = createBot("123:test", {
      client: { resolveAPIKey: vi.fn().mockResolvedValue("user-key") } as unknown as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn() },
      contexts: {
        upsertUser: vi.fn(),
        upsertChat: vi.fn(),
        upsertMember: vi.fn(),
        saveMessage: vi.fn(),
      },
      mediaStore: store,
      botToken: "123:test",
      resultMaxBytes: 10_000_000,
    });
    bot.botInfo = botInfo;
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    bot.api.config.use((_previous, method, payload) => {
      calls.push({ method, payload });
      if (method === "sendMessage") {
        return Promise.resolve({
          ok: true,
          result: {
            message_id: 78,
            date: 1_788_333_600,
            chat: { id: -1001, type: "supergroup", title: "Mia builders", is_forum: true },
            from: botInfo,
            text: "正在生成新图片……",
          },
        } as never);
      }
      return Promise.resolve({ ok: true, result: true } as never);
    });

    await bot.handleUpdate({
      update_id: 9007,
      callback_query: {
        id: "callback-again-1",
        from: {
          id: 42,
          is_bot: false,
          first_name: "Liz",
          username: "liz",
          language_code: "zh-CN",
        },
        message: {
          message_id: 77,
          message_thread_id: 12,
          date: 1_788_333_500,
          chat: { id: -1001, type: "supergroup", title: "Mia builders", is_forum: true },
          from: botInfo,
          photo: [{ file_id: "generated-photo", file_unique_id: "generated-unique", width: 1024, height: 1024 }],
          caption: "图片已生成",
        },
        chat_instance: "instance-1",
        data: `media:${claimed.job.id}:again`,
      },
    } as never);

    expect(calls[0]).toEqual({
      method: "answerCallbackQuery",
      payload: { callback_query_id: "callback-again-1" },
    });
    expect(calls[1]).toMatchObject({
      method: "sendMessage",
      payload: {
        chat_id: -1001,
        text: "正在生成新图片……",
        message_thread_id: 12,
        reply_parameters: { message_id: 77, allow_sending_without_reply: true },
      },
    });
    expect(store.getJobByIdempotencyKey("callback:callback-again-1")).toMatchObject({
      status: "queued",
      requestMessageId: 77,
      statusMessageId: 78,
      options: { ephemeralStatus: true, locale: "zh-CN" },
    });
  });
});
