import { describe, expect, it, vi } from "vitest";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import type { IntentRouter } from "../src/intent/router.js";
import { createLogger } from "../src/logger.js";
import { MediaStore } from "../src/media/store.js";
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
    const sendRichMessage = vi.fn()
      .mockResolvedValueOnce({ message_id: 6, date: 1_788_333_601, rich_message: { blocks: [] } })
      .mockRejectedValueOnce(new Error("force plain final response"));
    const deleteMessage = vi.fn().mockResolvedValue(true);
    const editMessageText = vi.fn().mockResolvedValue(true);
    const sendChatAction = vi.fn();
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
      api: { sendRichMessage, editMessageText, deleteMessage, sendChatAction, sendMessage },
      reply: vi.fn(),
    } as never);

    expect(sendRichMessage).toHaveBeenCalledWith(42, {
      blocks: [
        { type: "paragraph", text: "Thinking" },
        { type: "paragraph", text: "." },
      ],
    }, {});
    expect(deleteMessage).toHaveBeenCalledWith(42, 6);
    expect(sendChatAction).not.toHaveBeenCalled();
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

  it("deletes the animated Rich progress message before the final reply", async () => {
    vi.useFakeTimers();
    try {
      let finishChat: ((value: string) => void) | undefined;
      const chat = vi.fn().mockImplementation(() => new Promise<string>((resolve) => {
        finishChat = resolve;
      }));
      const sendRichMessage = vi.fn()
        .mockResolvedValueOnce({ message_id: 6, date: 1_788_333_601, rich_message: { blocks: [] } })
        .mockRejectedValueOnce(new Error("force plain final response"));
      const deleteMessage = vi.fn().mockResolvedValue(true);
      const editMessageText = vi.fn().mockResolvedValue(true);
      const sendMessage = vi.fn().mockResolvedValue({
        message_id: 8,
        date: 1_788_333_601,
        chat: { id: 42, type: "private", first_name: "Roma" },
        from: { id: 100, is_bot: true, first_name: "Mia", username: "MiaAssistantBot" },
        text: "最终回复",
      });
      const handler = createTextHandler({
        client: {
          resolveAPIKey: vi.fn().mockResolvedValue("user-key"),
          chat,
        } as unknown as APIMasterClient,
        logger: createLogger("silent"),
        settings: { getPreferences: vi.fn().mockReturnValue({ chatModel: "grok-4.5" }) },
        contexts: {
          upsertUser: vi.fn(), upsertChat: vi.fn(), upsertMember: vi.fn(), saveMessage: vi.fn(),
        },
      });

      const handling = handler({
        update: { update_id: 100 },
        chat: { id: 42, type: "private", first_name: "Roma" },
        from: { id: 42, is_bot: false, first_name: "Roma", language_code: "zh-CN" },
        message: {
          message_id: 7,
          date: 1_788_333_600,
          chat: { id: 42, type: "private", first_name: "Roma" },
          from: { id: 42, is_bot: false, first_name: "Roma", language_code: "zh-CN" },
          text: "查一下",
        },
        me: { id: 100, is_bot: true, first_name: "Mia", username: "MiaAssistantBot" },
        api: { sendRichMessage, editMessageText, deleteMessage, sendChatAction: vi.fn(), sendMessage },
        reply: vi.fn(),
      } as never);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(sendRichMessage).toHaveBeenCalledTimes(1);
      expect(editMessageText).toHaveBeenCalled();
      expect(editMessageText.mock.calls.every((call) => call[0] === 42 && call[1] === 6)).toBe(true);
      const editedPayloads = editMessageText.mock.calls.map((call) => call[2] as unknown);
      expect(editedPayloads).toEqual(expect.arrayContaining([
        { blocks: [{ type: "paragraph", text: "Thinking" }, { type: "paragraph", text: ".." }] },
        { blocks: [{ type: "paragraph", text: "Thinking" }, { type: "paragraph", text: "..." }] },
        { blocks: [{ type: "paragraph", text: "Thinking" }, { type: "paragraph", text: "." }] },
      ]));

      finishChat?.("最终回复");
      await vi.advanceTimersByTimeAsync(0);
      await handling;
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(deleteMessage).toHaveBeenCalledWith(42, 6);
      expect(deleteMessage.mock.invocationCallOrder[0]).toBeLessThan(
        sendMessage.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses one animated Rich progress message from routing through web search", async () => {
    vi.useFakeTimers();
    const mediaStore = new MediaStore(":memory:");
    try {
      let finishSearch: ((value: string) => void) | undefined;
      const chatMessages = vi.fn().mockImplementation(() => new Promise<string>((resolve) => {
        finishSearch = resolve;
      }));
      const classify = vi.fn().mockResolvedValue({
        intent: "chat",
        should_respond: true,
        response_to_message_id: null,
        confidence: 0.99,
        instruction: "查实时天气",
        media_source: "none",
        media_message_ids: [],
        image_options: null,
        video_options: null,
        final_response: "路由阶段草稿",
        needsWebSearch: true,
        conversation_mode: "task",
        onboarding_opportunity: false,
        profile_updates: null,
        missingRequired: [],
      });
      const sendRichMessage = vi.fn()
        .mockResolvedValueOnce({ message_id: 6, date: 1_788_333_601, rich_message: { blocks: [] } })
        .mockResolvedValueOnce({
          message_id: 8,
          date: 1_788_333_602,
          chat: { id: 42, type: "private", first_name: "Roma" },
          from: { id: 100, is_bot: true, first_name: "Mia", username: "MiaAssistantBot" },
          rich_message: { blocks: [{ type: "paragraph", text: "北京明天多云。" }] },
        });
      const editMessageText = vi.fn().mockResolvedValue(true);
      const deleteMessage = vi.fn().mockResolvedValue(true);
      const handler = createTextHandler({
        client: {
          resolveAPIKey: vi.fn().mockResolvedValue("user-key"),
          chatMessages,
        } as unknown as APIMasterClient,
        logger: createLogger("silent"),
        settings: { getPreferences: vi.fn().mockReturnValue({ chatModel: "deepseek-v4.1-flash" }) },
        contexts: {
          upsertUser: vi.fn(), upsertChat: vi.fn(), upsertMember: vi.fn(), saveMessage: vi.fn(),
        },
        router: { model: "deepseek-v4.1-flash", classify } as unknown as IntentRouter,
        mediaStore,
        botToken: "123:test",
        webSearchModel: "gpt-5.6-terra",
      });

      const handling = handler({
        update: { update_id: 100 },
        chat: { id: 42, type: "private", first_name: "Roma" },
        from: { id: 42, is_bot: false, first_name: "Roma", language_code: "zh-CN" },
        message: {
          message_id: 7,
          date: 1_788_333_600,
          chat: { id: 42, type: "private", first_name: "Roma" },
          from: { id: 42, is_bot: false, first_name: "Roma", language_code: "zh-CN" },
          text: "查一下北京明天天气",
        },
        me: { id: 100, is_bot: true, first_name: "Mia", username: "MiaAssistantBot" },
        api: { sendRichMessage, editMessageText, deleteMessage, sendChatAction: vi.fn(), sendMessage: vi.fn() },
        reply: vi.fn(),
      } as never);

      await vi.advanceTimersByTimeAsync(1_350);
      expect(chatMessages).toHaveBeenCalledOnce();
      expect(chatMessages.mock.calls[0]?.[3]).toMatchObject({ webSearch: true });
      expect(sendRichMessage).toHaveBeenCalledTimes(1);
      expect(deleteMessage).not.toHaveBeenCalled();
      expect(editMessageText).toHaveBeenCalled();
      expect(editMessageText.mock.calls.every((call) => call[0] === 42 && call[1] === 6)).toBe(true);

      finishSearch?.("北京明天多云。");
      await vi.advanceTimersByTimeAsync(0);
      await handling;

      expect(deleteMessage).toHaveBeenCalledTimes(1);
      expect(deleteMessage).toHaveBeenCalledWith(42, 6);
      expect(sendRichMessage).toHaveBeenCalledTimes(2);
      expect(deleteMessage.mock.invocationCallOrder[0]).toBeLessThan(
        sendRichMessage.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER,
      );
    } finally {
      mediaStore.close();
      vi.useRealTimers();
    }
  });

  it("shows a two-line Rich progress message immediately", async () => {
    vi.useFakeTimers();
    try {
      const sendRichMessage = vi.fn()
        .mockResolvedValueOnce({ message_id: 6, date: 1_788_333_601, rich_message: { blocks: [] } })
        .mockRejectedValueOnce(new Error("force plain final response"));
      const deleteMessage = vi.fn().mockResolvedValue(true);
      const editMessageText = vi.fn().mockResolvedValue(true);
      const sendMessage = vi.fn().mockResolvedValue({ message_id: 8, date: 1_788_333_601, text: "快速回复" });
      const handler = createTextHandler({
        client: {
          resolveAPIKey: vi.fn().mockResolvedValue("user-key"),
          chat: vi.fn().mockResolvedValue("快速回复"),
        } as unknown as APIMasterClient,
        logger: createLogger("silent"),
        settings: { getPreferences: vi.fn().mockReturnValue({ chatModel: "grok-4.5" }) },
        contexts: {
          upsertUser: vi.fn(), upsertChat: vi.fn(), upsertMember: vi.fn(), saveMessage: vi.fn(),
        },
      });

      const handling = handler({
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
        api: { sendRichMessage, editMessageText, deleteMessage, sendChatAction: vi.fn(), sendMessage },
        reply: vi.fn(),
      } as never);

      await handling;
      expect(sendRichMessage).toHaveBeenCalledWith(42, {
        blocks: [
          { type: "paragraph", text: "Thinking" },
          { type: "paragraph", text: "." },
        ],
      }, {});
      expect(deleteMessage).toHaveBeenCalledWith(42, 6);
      expect(sendMessage).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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
