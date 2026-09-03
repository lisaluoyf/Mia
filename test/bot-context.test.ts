import { describe, expect, it, vi } from "vitest";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import { createLogger } from "../src/logger.js";
import { createBot, createTextHandler } from "../src/telegram/bot.js";

describe("Telegram context capture", () => {
  it("stores an ordinary group message before the response policy ignores it", async () => {
    const contexts = {
      upsertUser: vi.fn(),
      upsertChat: vi.fn(),
      upsertMember: vi.fn(),
      saveMessage: vi.fn(),
    };
    const handler = createTextHandler({
      client: {} as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn() },
      contexts,
    });
    const reply = vi.fn();

    await handler({
      update: { update_id: 99 },
      chat: { id: -1001, type: "supergroup", title: "Mia builders", is_forum: true },
      message: {
        message_id: 7,
        message_thread_id: 12,
        date: 1_788_333_600,
        chat: { id: -1001, type: "supergroup", title: "Mia builders", is_forum: true },
        from: {
          id: 42,
          is_bot: false,
          first_name: "Mia",
          username: "mia-user",
          language_code: "zh-CN",
        },
        text: "大家好",
      },
      me: { id: 100, is_bot: true, first_name: "Mia", username: "MiaAssistantBot" },
      reply,
    } as never);

    expect(contexts.upsertUser).toHaveBeenCalledWith(expect.objectContaining({ telegramUserId: 42 }));
    expect(contexts.upsertChat).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -1001,
      type: "supergroup",
      isForum: true,
    }));
    expect(contexts.upsertMember).toHaveBeenCalledWith({
      chatId: -1001,
      telegramUserId: 42,
      status: null,
    });
    expect(contexts.upsertChat.mock.invocationCallOrder[0]).toBeLessThan(
      contexts.upsertMember.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(contexts.saveMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -1001,
      messageId: 7,
      threadId: 12,
      text: "大家好",
    }));
    expect(reply).not.toHaveBeenCalled();
  });

  it("stores the assistant reply before recording a successful private turn", async () => {
    const contexts = {
      upsertUser: vi.fn(),
      upsertChat: vi.fn(),
      upsertMember: vi.fn(),
      saveMessage: vi.fn(),
    };
    const compactor = { recordSuccessfulPrivateTurn: vi.fn() };
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 8,
      date: 1_788_333_601,
      chat: { id: 42, type: "private", first_name: "Roma" },
      from: { id: 100, is_bot: true, first_name: "Mia", username: "MiaAssistantBot" },
      text: "你好，Roma",
      reply_to_message: { message_id: 7 },
    });
    const handler = createTextHandler({
      client: {
        resolveAPIKey: vi.fn().mockResolvedValue("user-key"),
        chat: vi.fn().mockResolvedValue("你好，Roma"),
      } as unknown as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn().mockReturnValue({
        chatModel: "grok-4.5", visionModel: null, imageModel: "gpt-image-2", videoModel: "minimax-h3",
      }) },
      contexts,
      compactor: compactor as never,
    });

    await handler({
      update: { update_id: 100 },
      chat: { id: 42, type: "private", first_name: "Roma" },
      from: { id: 42, is_bot: false, first_name: "Roma", language_code: "zh-CN" },
      message: {
        message_id: 7,
        date: 1_788_333_600,
        chat: { id: 42, type: "private", first_name: "Roma" },
        from: { id: 42, is_bot: false, first_name: "Roma", language_code: "zh-CN" },
        text: "你好",
      },
      me: { id: 100, is_bot: true, first_name: "Mia", username: "MiaAssistantBot" },
      api: { sendChatAction: vi.fn(), sendMessage },
      reply: vi.fn(),
    } as never);

    expect(contexts.saveMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: 7, text: "你好" }));
    expect(contexts.saveMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: 8, text: "你好，Roma" }));
    expect(compactor.recordSuccessfulPrivateTurn).toHaveBeenCalledWith({
      chatId: 42,
      userId: 42,
      userMessageId: 7,
      assistantMessageId: 8,
    });
    expect(contexts.saveMessage.mock.invocationCallOrder.at(-1)).toBeLessThan(
      compactor.recordSuccessfulPrivateTurn.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("starts group compaction only after a successful group call", async () => {
    const contexts = {
      upsertUser: vi.fn(),
      upsertChat: vi.fn(),
      upsertMember: vi.fn(),
      saveMessage: vi.fn(),
    };
    const groupCompactor = { recordSuccessfulGroupTrigger: vi.fn() };
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 52,
      date: 1_788_333_601,
      chat: { id: -1001, type: "supergroup", title: "Mia builders" },
      from: { id: 100, is_bot: true, first_name: "Mia", username: "MiaAssistantBot" },
      text: "收到",
      reply_to_message: { message_id: 51 },
    });
    const handler = createTextHandler({
      client: {
        resolveAPIKey: vi.fn().mockResolvedValue("user-key"),
        chat: vi.fn().mockResolvedValue("收到"),
      } as unknown as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn().mockReturnValue({ chatModel: "grok-4.5" }) },
      contexts,
      groupCompactor: groupCompactor as never,
    });

    await handler({
      update: { update_id: 101 },
      chat: { id: -1001, type: "supergroup", title: "Mia builders" },
      from: { id: 42, is_bot: false, first_name: "Roma", language_code: "zh-CN" },
      message: {
        message_id: 51,
        date: 1_788_333_600,
        chat: { id: -1001, type: "supergroup", title: "Mia builders" },
        from: { id: 42, is_bot: false, first_name: "Roma", language_code: "zh-CN" },
        text: "@MiaAssistantBot 总结一下",
        entities: [{ type: "mention", offset: 0, length: 16 }],
      },
      me: { id: 100, is_bot: true, first_name: "Mia", username: "MiaAssistantBot" },
      api: { sendChatAction: vi.fn(), sendMessage },
      reply: vi.fn(),
    } as never);

    expect(groupCompactor.recordSuccessfulGroupTrigger).toHaveBeenCalledWith(
      { type: "group", chatId: -1001 },
      42,
    );
    expect(contexts.saveMessage.mock.invocationCallOrder.at(-1)).toBeLessThan(
      groupCompactor.recordSuccessfulGroupTrigger.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("does not let a regular group member clear shared context", async () => {
    const clearConversation = vi.fn();
    const bot = createBot("123:test", {
      client: {} as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn() },
      contexts: {
        upsertUser: vi.fn(), upsertChat: vi.fn(), upsertMember: vi.fn(), saveMessage: vi.fn(), clearConversation,
      },
      mediaStore: {
        claimTelegramUpdate: vi.fn().mockReturnValue(true),
        clearPendingIntent: vi.fn(),
      } as never,
    });
    bot.botInfo = {
      id: 100, is_bot: true, first_name: "Mia", username: "MiaAssistantBot",
      can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
      can_connect_to_business: false, has_main_web_app: false,
    };
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 53 });
    bot.api.config.use((_previous, method) => {
      if (method === "getChatMember") return Promise.resolve({
        ok: true,
        result: { status: "member", user: { id: 42, is_bot: false, first_name: "Roma" } },
      } as never);
      if (method === "sendMessage") {
        void sendMessage();
        return Promise.resolve({
          ok: true,
          result: {
            message_id: 53, date: 1_788_333_601,
            chat: { id: -1001, type: "supergroup", title: "Mia builders" },
            from: bot.botInfo, text: "Only group administrators can change media settings.",
          },
        } as never);
      }
      throw new Error(`Unexpected Telegram method: ${method}`);
    });

    await bot.handleUpdate({
      update_id: 102,
      message: {
        message_id: 52,
        date: 1_788_333_600,
        chat: { id: -1001, type: "supergroup", title: "Mia builders" },
        from: { id: 42, is_bot: false, first_name: "Roma", language_code: "zh-CN" },
        text: "/forget",
        entities: [{ type: "bot_command", offset: 0, length: 7 }],
      },
    });

    expect(clearConversation).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledOnce();
  });
});
