import { afterEach, describe, expect, it, vi } from "vitest";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import type { GroupSummaryService, PreparedGroupSummary } from "../src/context/group-summary.js";
import type { IntentRouter } from "../src/intent/router.js";
import { createLogger } from "../src/logger.js";
import { MediaStore } from "../src/media/store.js";
import { createBot, isExplicitGroupSummaryPhrase } from "../src/telegram/bot.js";

const botInfo = {
  id: 100, is_bot: true, first_name: "Mia", username: "MiaAssistantBot",
  can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
};

const prepared: PreparedGroupSummary = {
  content: {
    title: { text: "本周讨论", sourceMessageIds: [1] },
    overview: { text: "完成了总结方案。", sourceMessageIds: [1] },
    topics: [], decisions: [], todos: [], openQuestions: [], participants: [], historicalContext: [],
  },
  scope: { type: "topic", chatId: -1001, threadId: 12 },
  messageCount: 17,
  fromMessageId: 1,
  throughMessageId: 17,
  currentMessageId: 18,
  truncated: false,
  debugId: null,
  persistence: null,
  debugDetails: {},
};

function contexts() {
  return {
    upsertUser: vi.fn(), upsertChat: vi.fn(), upsertMember: vi.fn(), saveMessage: vi.fn(),
    listRecentMessages: vi.fn().mockReturnValue([]), getLatestSummary: vi.fn().mockReturnValue(null),
  };
}

function installApi(bot: ReturnType<typeof createBot>) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  let nextMessageId = 800;
  bot.api.config.use((_previous, method, payload) => {
    const safe = payload as unknown as Record<string, unknown>;
    calls.push({ method, payload: safe });
    if (method === "sendMessage" || method === "sendRichMessage") {
      nextMessageId += 1;
      return Promise.resolve({ ok: true, result: {
        message_id: nextMessageId,
        message_thread_id: safe.message_thread_id,
        date: 1_788_333_601,
        chat: Number(safe.chat_id) < 0
          ? { id: Number(safe.chat_id), type: "supergroup", title: "Bot 玩家", is_forum: true }
          : { id: Number(safe.chat_id), type: "private", first_name: "Alen" },
        from: botInfo,
        ...(method === "sendRichMessage"
          ? { rich_message: safe.rich_message }
          : { text: typeof safe.text === "string" ? safe.text : "" }),
      } } as never);
    }
    return Promise.resolve({ ok: true, result: true } as never);
  });
  return calls;
}

function groupUpdate(text: string, messageId = 18) {
  return {
    update_id: 500 + messageId,
    message: {
      message_id: messageId, message_thread_id: 12, date: 1_788_333_600,
      chat: { id: -1001, type: "supergroup", title: "Bot 玩家", is_forum: true },
      from: { id: 42, is_bot: false, first_name: "Alen", language_code: "zh-CN" },
      text,
      ...(text.startsWith("@MiaAssistantBot")
        ? { entities: [{ type: "mention", offset: 0, length: 16 }] }
        : {}),
    },
  } as never;
}

describe("Telegram group summary entry points", () => {
  let mediaStore: MediaStore | undefined;

  afterEach(() => {
    mediaStore?.close();
    mediaStore = undefined;
    vi.clearAllMocks();
  });

  it("sends /summary as safe HTML in the same Topic and persists before committing", async () => {
    mediaStore = new MediaStore(":memory:");
    const contextStore = contexts();
    const summarize = vi.fn().mockResolvedValue(prepared);
    const complete = vi.fn();
    const groupCompactor = { recordSuccessfulGroupTrigger: vi.fn() };
    const bot = createBot("123:test", {
      client: {} as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn() },
      contexts: contextStore,
      groupSummary: { model: "gpt-5.4", summarize, complete, failDelivery: vi.fn() } as unknown as GroupSummaryService,
      groupCompactor: groupCompactor as never,
      router: { model: "gpt-5.4", classify: vi.fn() } as unknown as IntentRouter,
      mediaStore,
      botToken: "123:test",
    });
    bot.botInfo = botInfo;
    const calls = installApi(bot);

    await bot.handleUpdate(groupUpdate("/summary"));

    expect(summarize).toHaveBeenCalledWith({
      scope: { type: "topic", chatId: -1001, threadId: 12 },
      requesterUserId: 42,
      currentMessageId: 18,
      locale: "zh-CN",
    });
    const sent = calls.find((call) => call.method === "sendRichMessage");
    expect(sent?.payload).toMatchObject({
      chat_id: -1001,
      message_thread_id: 12,
      reply_parameters: { message_id: 18, allow_sending_without_reply: true },
    });
    const richMessage = sent?.payload.rich_message as {
      blocks?: Array<{ type?: unknown; text?: unknown }>;
    } | undefined;
    expect(richMessage?.blocks?.some((block) =>
      block.type === "heading" && typeof block.text === "string" && block.text.includes("本周讨论"))).toBe(true);
    expect(contextStore.saveMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: 801 }));
    expect(complete).toHaveBeenCalledWith(prepared, 801, [801], expect.objectContaining({
      deliveryMode: "rich_message",
      chunkCount: 1,
    }));
    expect(contextStore.saveMessage.mock.invocationCallOrder.at(-1)).toBeLessThan(
      complete.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(groupCompactor.recordSuccessfulGroupTrigger).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === "getChatMember")).toBe(false);
  });

  it.each(["总结下聊天记录", "总结一下刚才讨论", "summarize the chat", "recap our discussion"])(
    "routes the explicit phrase %s directly without an intent call",
    async (text) => {
      mediaStore = new MediaStore(":memory:");
      const classify = vi.fn();
      const summarize = vi.fn().mockResolvedValue(prepared);
      const bot = createBot("123:test", {
        client: {} as APIMasterClient,
        logger: createLogger("silent"),
        settings: { getPreferences: vi.fn() }, contexts: contexts(),
        groupSummary: { model: "gpt-5.4", summarize, complete: vi.fn(), failDelivery: vi.fn() } as unknown as GroupSummaryService,
        router: { model: "gpt-5.4", classify } as unknown as IntentRouter,
        mediaStore, botToken: "123:test",
      });
      bot.botInfo = botInfo;
      installApi(bot);

      await bot.handleUpdate(groupUpdate(text));

      expect(summarize).toHaveBeenCalledOnce();
      expect(classify).not.toHaveBeenCalled();
    },
  );

  it("allows a routed fuzzy group_summary with guest credentials", async () => {
    mediaStore = new MediaStore(":memory:");
    const summarize = vi.fn().mockResolvedValue(prepared);
    const classify = vi.fn().mockResolvedValue({
      intent: "group_summary", confidence: 0.9, instruction: "", media_source: "none",
      image_options: null, video_options: null, final_response: null,
      conversation_mode: "task", onboarding_opportunity: false, profile_updates: null, missingRequired: [],
    });
    const bot = createBot("123:test", {
      client: {} as APIMasterClient,
      chatCredentials: { resolve: vi.fn().mockResolvedValue({
        apiKey: "guest-key", model: "gpt-5.4", source: "guest", fallbackReason: "telegram_not_bound",
      }) },
      logger: createLogger("silent"), settings: { getPreferences: vi.fn() }, contexts: contexts(),
      groupSummary: { model: "gpt-5.4", summarize, complete: vi.fn(), failDelivery: vi.fn() } as unknown as GroupSummaryService,
      router: { model: "gpt-5.4", classify } as unknown as IntentRouter,
      mediaStore, botToken: "123:test",
    });
    bot.botInfo = botInfo;
    installApi(bot);

    await bot.handleUpdate(groupUpdate("@MiaAssistantBot 帮大家梳理一下前面的要点"));

    expect(classify).toHaveBeenCalledOnce();
    expect(classify.mock.calls[0]?.[0]).toMatchObject({ allowGroupSummary: true });
    expect(summarize).toHaveBeenCalledOnce();
  });

  it("rejects /summary in private chat without invoking the service", async () => {
    mediaStore = new MediaStore(":memory:");
    const summarize = vi.fn();
    const bot = createBot("123:test", {
      client: {} as APIMasterClient,
      logger: createLogger("silent"), settings: { getPreferences: vi.fn() }, contexts: contexts(),
      groupSummary: { model: "gpt-5.4", summarize, complete: vi.fn(), failDelivery: vi.fn() } as unknown as GroupSummaryService,
      router: { model: "gpt-5.4", classify: vi.fn() } as unknown as IntentRouter,
      mediaStore, botToken: "123:test",
    });
    bot.botInfo = botInfo;
    const calls = installApi(bot);

    await bot.handleUpdate({
      update_id: 700,
      message: {
        message_id: 7, date: 1_788_333_600,
        chat: { id: 42, type: "private", first_name: "Alen" },
        from: { id: 42, is_bot: false, first_name: "Alen", language_code: "zh-CN" },
        text: "/summary",
      },
    });

    expect(summarize).not.toHaveBeenCalled();
    const richMessage = calls.find((call) => call.method === "sendRichMessage")?.payload.rich_message as {
      blocks?: Array<{ type?: unknown; text?: unknown }>;
    } | undefined;
    expect(richMessage?.blocks?.some((block) =>
      block.type === "paragraph" && typeof block.text === "string" && block.text.includes("仅支持群和 Topic"))).toBe(true);
  });

  it("keeps the direct phrase matcher narrow", () => {
    expect(isExplicitGroupSummaryPhrase("总结一下刚才讨论")).toBe(true);
    expect(isExplicitGroupSummaryPhrase("recap the chat")).toBe(true);
    expect(isExplicitGroupSummaryPhrase("总结这篇文章")).toBe(false);
    expect(isExplicitGroupSummaryPhrase("请写一份总结报告")).toBe(false);
  });
});
