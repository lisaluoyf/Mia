import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import type { ChatCredentialProvider } from "../src/credentials/chat.js";
import type { IntentRouter, RoutedIntent } from "../src/intent/router.js";
import { createLogger } from "../src/logger.js";
import { MediaStore } from "../src/media/store.js";
import { ContextStore } from "../src/storage/store.js";
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

function reply(text: string) {
  return {
    version: 1 as const,
    title: null,
    blocks: [{ type: "paragraph" as const, heading: null, emoji: null, text, items: [], ordered: false, language: null }],
    actions: [],
  };
}

function routed(options: { respond?: boolean; target?: number | null; text?: string } = {}): RoutedIntent {
  const respond = options.respond ?? true;
  return {
    intent: "chat",
    should_respond: respond,
    response_to_message_id: options.target ?? null,
    confidence: 0.99,
    instruction: respond ? "continue" : "",
    media_source: "none",
    media_message_ids: [],
    image_options: null,
    video_options: null,
    reply: respond ? reply(options.text ?? "Mia reply") : null,
    final_response: null,
    conversation_mode: "task",
    onboarding_opportunity: false,
    profile_updates: null,
    missingRequired: [],
  };
}

function update(options: {
  updateId: number;
  messageId: number;
  userId?: number;
  text?: string;
  threadId?: number;
  mention?: boolean;
  replyToBot?: boolean;
  photo?: boolean;
  sticker?: boolean;
}) {
  const text = options.text;
  return {
    update_id: options.updateId,
    message: {
      message_id: options.messageId,
      ...(options.threadId ? { message_thread_id: options.threadId } : {}),
      date: Math.floor(Date.now() / 1000),
      chat: { id: -1001, type: "supergroup", title: "Mia builders", is_forum: true },
      from: { id: options.userId ?? 42, is_bot: false, first_name: `User ${options.userId ?? 42}`, language_code: "zh-CN" },
      ...(text === undefined ? {} : options.photo ? { caption: text } : { text }),
      ...(options.mention && text ? options.photo
        ? { caption_entities: [{ type: "mention", offset: 0, length: 16 }] }
        : { entities: [{ type: "mention", offset: 0, length: 16 }] } : {}),
      ...(options.replyToBot ? {
        reply_to_message: {
          message_id: 700,
          date: Math.floor(Date.now() / 1000) - 1,
          chat: { id: -1001, type: "supergroup", title: "Mia builders" },
          from: botInfo,
          text: "Earlier Mia reply",
        },
      } : {}),
      ...(options.photo ? {
        photo: [{ file_id: `photo-${options.messageId}`, file_unique_id: `unique-${options.messageId}`, width: 100, height: 100 }],
      } : {}),
      ...(options.sticker ? {
        sticker: {
          file_id: `sticker-${options.messageId}`,
          file_unique_id: `sticker-unique-${options.messageId}`,
          type: "regular",
          width: 100,
          height: 100,
          is_animated: false,
          is_video: false,
        },
      } : {}),
    },
  } as never;
}

describe("Mia group follow-up", () => {
  let contexts: ContextStore;
  let mediaStore: MediaStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00.000Z"));
    contexts = new ContextStore(":memory:");
    mediaStore = new MediaStore(":memory:");
  });

  afterEach(() => {
    contexts.close();
    mediaStore.close();
    vi.useRealTimers();
  });

  function setup(classify: ReturnType<typeof vi.fn>) {
    let failMessages = false;
    const credentials: ChatCredentialProvider = {
      resolve: vi.fn().mockResolvedValue({
        apiKey: "requester-key", model: "gpt-5.4", source: "user", fallbackReason: null,
      }),
    };
    const bot = createBot("123:test", {
      client: {} as APIMasterClient,
      chatCredentials: credentials,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn().mockReturnValue({ chatModel: "gpt-5.4" }) },
      contexts,
      router: { model: "gpt-5.4", classify } as unknown as IntentRouter,
      mediaStore,
      botToken: "123:test",
      followUpCredential: { apiKey: "public-follow-up-key", model: "gpt-5.4" },
    });
    bot.botInfo = botInfo;
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    bot.api.config.use((_previous, method, payload) => {
      const data = payload as unknown as Record<string, unknown>;
      calls.push({ method, payload: data });
      if (method === "sendMessage") {
        if (failMessages) return Promise.reject(new Error("Telegram send failed"));
        return Promise.resolve({
          ok: true,
          result: {
            message_id: 700 + calls.length,
            date: Math.floor(Date.now() / 1000),
            chat: { id: -1001, type: "supergroup", title: "Mia builders", is_forum: true },
            from: botInfo,
            text: typeof data.text === "string" ? data.text : "",
          },
        } as never);
      }
      return Promise.resolve({ ok: true, result: true } as never);
    });
    return { bot, calls, credentials, failMessages: () => { failMessages = true; } };
  }

  it("wakes on mention, batches every member, and silently observes unrelated discussion", async () => {
    const classify = vi.fn()
      .mockResolvedValueOnce(routed({ text: "我在。" }))
      .mockResolvedValueOnce(routed({ respond: false }));
    const { bot, calls } = setup(classify);

    await bot.handleUpdate(update({ updateId: 1, messageId: 1, text: "普通群消息", threadId: 12 }));
    expect(classify).not.toHaveBeenCalled();
    await bot.handleUpdate(update({ updateId: 2, messageId: 2, text: "@MiaAssistantBot 帮我看看", threadId: 12, mention: true }));
    expect(classify.mock.calls[0]?.[1]).toBe("requester-key");
    expect(contexts.getActiveGroupFollowUp({ type: "topic", chatId: -1001, threadId: 12 })).not.toBeNull();

    await bot.handleUpdate(update({ updateId: 3, messageId: 3, userId: 43, text: "我补充第一点", threadId: 12 }));
    await vi.advanceTimersByTimeAsync(1_500);
    await bot.handleUpdate(update({ updateId: 4, messageId: 4, userId: 44, text: "这个是我们之间的闲聊", threadId: 12 }));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(classify).toHaveBeenCalledTimes(2);
    expect(classify.mock.calls[1]?.[0]).toMatchObject({
      participationMode: "selective",
      followUpBatchMessageIds: [3, 4],
      followUpContext: {
        scopeType: "topic",
        chatId: -1001,
        threadId: 12,
        awakenedByUserId: 42,
        lastHandledAt: "2026-09-03T10:00:00.000Z",
      },
    });
    expect(classify.mock.calls[1]?.[1]).toBe("public-follow-up-key");
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "sendChatAction")).toHaveLength(1);
  });

  it("replies to the selected batch message and extends the session only after intervening", async () => {
    const classify = vi.fn()
      .mockResolvedValueOnce(routed({ text: "已唤醒。" }))
      .mockResolvedValueOnce(routed({ target: 3, text: "继续处理完成。" }))
      .mockResolvedValueOnce(routed({ respond: false }));
    const { bot, calls } = setup(classify);
    await bot.handleUpdate(update({ updateId: 1, messageId: 1, text: "@MiaAssistantBot 开始", threadId: 12, mention: true }));

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await bot.handleUpdate(update({ updateId: 2, messageId: 3, userId: 43, text: "继续刚才的处理", threadId: 12 }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(contexts.getActiveGroupFollowUp(
      { type: "topic", chatId: -1001, threadId: 12 },
      new Date("2026-09-03T10:18:00.000Z"),
    )).not.toBeNull();
    const replies = calls.filter((call) => call.method === "sendMessage");
    expect(replies.at(-1)?.payload.reply_parameters).toMatchObject({ message_id: 3 });

    vi.setSystemTime(new Date("2026-09-03T10:19:02.000Z"));
    await bot.handleUpdate(update({ updateId: 3, messageId: 4, text: "还在吗", threadId: 12 }));
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it("isolates topics, wakes on direct reply, and ignores pure images while evaluating captions", async () => {
    const classify = vi.fn()
      .mockResolvedValueOnce(routed({ text: "已唤醒。" }))
      .mockResolvedValueOnce(routed({ respond: false }));
    const { bot } = setup(classify);
    await bot.handleUpdate(update({ updateId: 1, messageId: 1, text: "继续", threadId: 12, replyToBot: true }));

    await bot.handleUpdate(update({ updateId: 2, messageId: 2, text: "另一个 Topic", threadId: 13 }));
    await bot.handleUpdate(update({ updateId: 3, messageId: 3, photo: true, threadId: 12 }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(classify).toHaveBeenCalledTimes(1);

    await bot.handleUpdate(update({ updateId: 4, messageId: 4, text: "这张图是补充材料", photo: true, threadId: 12 }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(classify).toHaveBeenCalledTimes(2);
    expect(classify.mock.calls[1]?.[0]).toMatchObject({
      participationMode: "selective",
      followUpBatchMessageIds: [4],
      mediaCount: 1,
    });
  });

  it("stores stickers and edited messages without evaluating them", async () => {
    const classify = vi.fn().mockResolvedValue(routed({ text: "已唤醒。" }));
    const { bot } = setup(classify);
    await bot.handleUpdate(update({ updateId: 1, messageId: 1, text: "@MiaAssistantBot 开始", threadId: 12, mention: true }));
    await bot.handleUpdate(update({ updateId: 2, messageId: 2, sticker: true, threadId: 12 }));
    await bot.handleUpdate({
      update_id: 3,
      edited_message: {
        message_id: 2,
        message_thread_id: 12,
        date: Math.floor(Date.now() / 1000),
        edit_date: Math.floor(Date.now() / 1000) + 1,
        chat: { id: -1001, type: "supergroup", title: "Mia builders", is_forum: true },
        from: { id: 42, is_bot: false, first_name: "User 42", language_code: "zh-CN" },
        sticker: {
          file_id: "sticker-2",
          file_unique_id: "sticker-unique-2",
          type: "regular",
          width: 100,
          height: 100,
          is_animated: false,
          is_video: false,
        },
      },
    } as never);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(contexts.getMessage(-1001, 2)).toMatchObject({ contentType: "sticker" });
    expect(classify).toHaveBeenCalledOnce();
  });

  it("does not resume a pending media action when selective routing chooses to observe", async () => {
    const classify = vi.fn()
      .mockResolvedValueOnce(routed({ text: "已唤醒。" }))
      .mockResolvedValueOnce(routed({ respond: false }));
    const { bot, calls } = setup(classify);
    await bot.handleUpdate(update({ updateId: 1, messageId: 1, text: "@MiaAssistantBot 开始", mention: true }));
    mediaStore.savePendingIntent({
      telegramUserId: 42,
      chatId: -1001,
      threadId: null,
      intent: "image_generate",
      slots: {
        intent: "image_generate",
        should_respond: true,
        response_to_message_id: null,
        confidence: 0.99,
        instruction: "等待补充",
        media_source: "none",
        media_message_ids: [],
        image_options: { aspect_ratio: null },
        video_options: null,
        reply: null,
        final_response: null,
        conversation_mode: "task",
        onboarding_opportunity: false,
        profile_updates: null,
      },
      missingRequired: ["instruction"],
      sourceMessageIds: [1],
    });

    await bot.handleUpdate(update({ updateId: 2, messageId: 2, text: "这是群成员之间的说明" }));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(classify).toHaveBeenCalledTimes(2);
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    expect(mediaStore.getPendingIntent({ telegramUserId: 42, chatId: -1001, threadId: null }))
      .toMatchObject({ intent: "image_generate", missingRequired: ["instruction"] });
  });

  it("cancels a pending automatic batch when a new mention arrives", async () => {
    const classify = vi.fn()
      .mockResolvedValueOnce(routed({ text: "已唤醒。" }))
      .mockResolvedValueOnce(routed({ text: "处理新的明确请求。" }));
    const { bot } = setup(classify);
    await bot.handleUpdate(update({ updateId: 1, messageId: 1, text: "@MiaAssistantBot 开始", mention: true }));
    await bot.handleUpdate(update({ updateId: 2, messageId: 2, text: "待合并的补充" }));
    await vi.advanceTimersByTimeAsync(1_000);
    await bot.handleUpdate(update({ updateId: 3, messageId: 3, text: "@MiaAssistantBot 以这个为准", mention: true }));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(classify).toHaveBeenCalledTimes(2);
    expect(classify.mock.calls[1]?.[0]).toMatchObject({ participationMode: "required" });
  });

  it("silently rate-limits the 31st automatic evaluation in one window", async () => {
    const classify = vi.fn().mockImplementation((input: { participationMode?: string }) =>
      Promise.resolve(input.participationMode === "selective"
        ? routed({ respond: false })
        : routed({ text: "已唤醒。" })));
    const { bot, calls } = setup(classify);
    await bot.handleUpdate(update({ updateId: 1, messageId: 1, text: "@MiaAssistantBot 开始", mention: true }));

    for (let index = 0; index < 31; index += 1) {
      await bot.handleUpdate(update({
        updateId: index + 2,
        messageId: index + 2,
        text: `普通消息 ${index + 1}`,
      }));
      await vi.advanceTimersByTimeAsync(2_000);
    }

    expect(classify).toHaveBeenCalledTimes(31);
    expect(classify.mock.calls.filter((call) =>
      (call[0] as { participationMode?: string }).participationMode === "selective")).toHaveLength(30);
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
  });

  it("does not extend the session when Telegram delivery fails", async () => {
    const classify = vi.fn()
      .mockResolvedValueOnce(routed({ text: "已唤醒。" }))
      .mockResolvedValueOnce(routed({ target: 2, text: "这条发送会失败。" }));
    const { bot, failMessages } = setup(classify);
    await bot.handleUpdate(update({ updateId: 1, messageId: 1, text: "@MiaAssistantBot 开始", mention: true }));

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    failMessages();
    await bot.handleUpdate(update({ updateId: 2, messageId: 2, text: "继续处理" }));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(contexts.getActiveGroupFollowUp(
      { type: "group", chatId: -1001 },
      new Date("2026-09-03T10:10:00.000Z"),
    )).toBeNull();
  });
});
