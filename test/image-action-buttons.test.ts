import { afterEach, describe, expect, it, vi } from "vitest";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import type { IntentRouter } from "../src/intent/router.js";
import { createLogger } from "../src/logger.js";
import { MediaStore } from "../src/media/store.js";
import { createBot } from "../src/telegram/bot.js";
import type { AgentService } from "../src/agent/service.js";

const botInfo = {
  id: 100, is_bot: true, first_name: "Mia", username: "MiaAssistantBot",
  can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
};

function contextStubs() {
  return {
    upsertUser: vi.fn(), upsertChat: vi.fn(), upsertMember: vi.fn(), saveMessage: vi.fn(),
  };
}

describe("image action buttons", () => {
  let store: MediaStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it("offers localized actions and only lets the image owner create one pending action", async () => {
    store = new MediaStore(":memory:");
    const classify = vi.fn();
    const bot = createBot("123:test", {
      client: {} as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn(), getSnapshot: vi.fn().mockResolvedValue({}) },
      contexts: contextStubs(),
      router: { model: "gpt-5.4", classify } as unknown as IntentRouter,
      mediaStore: store,
      botToken: "123:test",
    });
    bot.botInfo = botInfo;
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    let sentMessageId = 700;
    bot.api.config.use((_previous, method, payload) => {
      const safe = payload as unknown as Record<string, unknown>;
      calls.push({ method, payload: safe });
      if (method === "sendMessage") {
        sentMessageId += 1;
        return Promise.resolve({ ok: true, result: {
          message_id: sentMessageId, date: 1_788_333_601,
          chat: { id: 42, type: "private", first_name: "Liz" },
          from: botInfo, text: typeof safe.text === "string" ? safe.text : "",
        } } as never);
      }
      return Promise.resolve({ ok: true, result: true } as never);
    });

    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 40, date: 1_788_333_600,
        chat: { id: 42, type: "private", first_name: "Liz" },
        from: { id: 42, is_bot: false, first_name: "Liz", language_code: "zh-CN" },
        photo: [{ file_id: "photo", file_unique_id: "unique", width: 100, height: 100 }],
      },
    } as never);

    const question = calls.find((call) => call.method === "sendMessage");
    expect(question?.payload.text).toBe("这张图想让我做什么？我可以帮你看图、修改图片、做成贴纸或视频。");
    expect(question?.payload.reply_markup).toEqual({ inline_keyboard: [
      [
        { text: "看懂这张图", callback_data: "image_action:42:40:analyze" },
        { text: "修改图片", callback_data: "image_action:42:40:edit" },
      ],
      [
        { text: "做成贴纸", callback_data: "image_action:42:40:sticker" },
        { text: "做成视频", callback_data: "image_action:42:40:video" },
      ],
    ] });
    expect(classify).not.toHaveBeenCalled();

    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "wrong-owner", from: { id: 43, is_bot: false, first_name: "Other", language_code: "zh-CN" },
        message: {
          message_id: 701, date: 1_788_333_601,
          chat: { id: 42, type: "private", first_name: "Liz" }, from: botInfo,
          text: "这张图想让我做什么？我可以帮你看图、修改图片、做成贴纸或视频。",
        },
        chat_instance: "instance", data: "image_action:42:40:analyze",
      },
    } as never);
    expect(calls.at(-1)).toMatchObject({
      method: "answerCallbackQuery",
      payload: { callback_query_id: "wrong-owner", show_alert: true },
    });

    const callbackMessage = {
      message_id: 701, date: 1_788_333_601,
      chat: { id: 42, type: "private", first_name: "Liz" }, from: botInfo,
      text: "这张图想让我做什么？我可以帮你看图、修改图片、做成贴纸或视频。",
    };
    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "owner", from: { id: 42, is_bot: false, first_name: "Liz", language_code: "zh-CN" },
        message: callbackMessage, chat_instance: "instance", data: "image_action:42:40:analyze",
      },
    } as never);

    expect(calls.some((call) => call.method === "editMessageReplyMarkup")).toBe(true);
    const prompt = calls.filter((call) => call.method === "sendMessage").at(-1);
    expect(prompt?.payload).toMatchObject({
      text: "回复这条消息，告诉我你想了解图片中的什么。",
    });
    expect(prompt?.payload.reply_markup).toBeUndefined();
    expect(prompt?.payload).toMatchObject({
      reply_parameters: { message_id: 40, allow_sending_without_reply: true },
    });
    expect(store.getPendingIntent({ telegramUserId: 42, chatId: 42, threadId: null })).toMatchObject({
      intent: "vision_qa",
      sourceMessageIds: [40, 702],
    });

    const beforeDuplicate = calls.length;
    await bot.handleUpdate({
      update_id: 4,
      callback_query: {
        id: "duplicate", from: { id: 42, is_bot: false, first_name: "Liz", language_code: "zh-CN" },
        message: callbackMessage, chat_instance: "instance", data: "image_action:42:40:analyze",
      },
    } as never);
    expect(calls.slice(beforeDuplicate).map((call) => call.method)).toEqual(["answerCallbackQuery"]);
  });

  it("keeps the image action menu ahead of Agent Loop for a bare upload", async () => {
    store = new MediaStore(":memory:");
    const enqueue = vi.fn();
    const bot = createBot("123:test", {
      agent: { enabled: () => true, ownsUpdate: () => true, enqueue } as unknown as AgentService,
      client: {} as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn(), getSnapshot: vi.fn().mockResolvedValue({}) },
      contexts: contextStubs(),
      router: { model: "gpt-5.4", classify: vi.fn() } as unknown as IntentRouter,
      mediaStore: store,
      botToken: "123:test",
    });
    bot.botInfo = botInfo;
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    bot.api.config.use((_previous, method, payload) => {
      calls.push({ method, payload });
      if (method === "sendMessage") {
        return Promise.resolve({ ok: true, result: {
          message_id: 701, date: 1_788_333_601,
          chat: { id: 42, type: "private", first_name: "Liz" }, from: botInfo,
          text: "menu",
        } } as never);
      }
      return Promise.resolve({ ok: true, result: true } as never);
    });

    await bot.handleUpdate({
      update_id: 11,
      message: {
        message_id: 41, date: 1_788_333_600,
        chat: { id: 42, type: "private", first_name: "Liz" },
        from: { id: 42, is_bot: false, first_name: "Liz", language_code: "zh-CN" },
        photo: [{ file_id: "photo", file_unique_id: "unique", width: 100, height: 100 }],
      },
    } as never);

    expect(enqueue).not.toHaveBeenCalled();
    const menu = calls.find((call) => call.method === "sendMessage")?.payload;
    expect(menu).toMatchObject({
      text: "这张图想让我做什么？我可以帮你看图、修改图片、做成贴纸或视频。",
    });
    expect(menu?.reply_markup).toEqual({ inline_keyboard: [
      [
        { text: "看懂这张图", callback_data: "image_action:42:41:analyze" },
        { text: "修改图片", callback_data: "image_action:42:41:edit" },
      ],
      [
        { text: "做成贴纸", callback_data: "image_action:42:41:sticker" },
        { text: "做成视频", callback_data: "image_action:42:41:video" },
      ],
    ] });
  });
});
