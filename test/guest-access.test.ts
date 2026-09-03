import { afterEach, describe, expect, it, vi } from "vitest";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import { ResolverError } from "../src/clients/apimaster.js";
import type { ChatCredentialProvider } from "../src/credentials/chat.js";
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

const guestCredentials: ChatCredentialProvider = {
  resolve: vi.fn().mockResolvedValue({
    apiKey: "guest-test-key",
    model: "gpt-5.4",
    source: "guest",
    fallbackReason: "telegram_not_bound",
  }),
};

function contextStubs() {
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
    const safePayload = payload as unknown as Record<string, unknown>;
    calls.push({ method, payload: safePayload });
    if (method === "sendMessage") {
      const chatId = Number(safePayload.chat_id);
      const text = typeof safePayload.text === "string" ? safePayload.text : "";
      return Promise.resolve({
        ok: true,
        result: {
          message_id: 900 + calls.length,
          date: 1_788_333_601,
          chat: chatId > 0
            ? { id: chatId, type: "private", first_name: "Guest" }
            : { id: chatId, type: "supergroup", title: "Guests", is_forum: true },
          from: botInfo,
          text,
        },
      } as never);
    }
    return Promise.resolve({ ok: true, result: true } as never);
  });
  return calls;
}

describe("Mia guest access", () => {
  let mediaStore: MediaStore | undefined;

  afterEach(() => {
    mediaStore?.close();
    mediaStore = undefined;
    vi.clearAllMocks();
  });

  it.each([
    { chat: { id: 42, type: "private", first_name: "Guest" }, text: "你好", threadId: undefined },
    { chat: { id: -1001, type: "supergroup", title: "Guests", is_forum: true }, text: "@MiaAssistantBot 你好", threadId: 12 },
  ])("answers guest text in $chat.type chats and preserves the Topic", async ({ chat, text, threadId }) => {
    mediaStore = new MediaStore(":memory:");
    const classify = vi.fn().mockResolvedValue({
      intent: "chat", confidence: 0.99, instruction: "", media_source: "none",
      image_options: null, video_options: null, final_response: "你好，我是 Mia。",
      conversation_mode: "casual", onboarding_opportunity: false, profile_updates: null,
      missingRequired: [],
    });
    const bot = createBot("123:test", {
      client: {} as APIMasterClient,
      chatCredentials: guestCredentials,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn().mockReturnValue({ chatModel: "grok-4.5" }) },
      contexts: contextStubs(),
      router: { model: "gpt-5.4", classify } as unknown as IntentRouter,
      mediaStore,
      botToken: "123:test",
    });
    bot.botInfo = botInfo;
    const calls = installApi(bot);

    await bot.handleUpdate({
      update_id: chat.id === 42 ? 1001 : 1002,
      message: {
        message_id: 7,
        ...(threadId === undefined ? {} : { message_thread_id: threadId }),
        date: 1_788_333_600,
        chat,
        from: { id: 42, is_bot: false, first_name: "Guest", language_code: "zh-CN" },
        text,
        ...(chat.id < 0 ? { entities: [{ type: "mention", offset: 0, length: 16 }] } : {}),
      },
    } as never);

    expect(classify).toHaveBeenCalledOnce();
    expect(classify.mock.calls[0]?.[1]).toBe("guest-test-key");
    expect(classify.mock.calls[0]?.[2]).toEqual([]);
    expect(classify.mock.calls[0]?.[3]).toBe("gpt-5.4");
    const sent = calls.find((call) => call.method === "sendMessage");
    expect(sent?.payload.text).toBe("你好，我是 Mia。");
    if (threadId !== undefined) expect(sent?.payload.message_thread_id).toBe(threadId);
  });

  it("blocks a natural-language media intent before any guest Token reaches a media model", async () => {
    mediaStore = new MediaStore(":memory:");
    const classify = vi.fn().mockResolvedValue({
      intent: "image_generate", confidence: 0.99, instruction: "一只猫", media_source: "none",
      image_options: { aspect_ratio: "1:1" }, video_options: null, final_response: null,
      conversation_mode: "task", onboarding_opportunity: false, profile_updates: null,
      missingRequired: [],
    });
    const client = { resolveAPIKey: vi.fn() };
    const bot = createBot("123:test", {
      client: client as unknown as APIMasterClient,
      chatCredentials: guestCredentials,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn().mockReturnValue({ imageModel: "gpt-image-2" }) },
      contexts: contextStubs(),
      router: { model: "gpt-5.4", classify } as unknown as IntentRouter,
      mediaStore,
      botToken: "123:test",
    });
    bot.botInfo = botInfo;
    const calls = installApi(bot);

    await bot.handleUpdate({
      update_id: 1003,
      message: {
        message_id: 8, date: 1_788_333_600,
        chat: { id: 42, type: "private", first_name: "Guest" },
        from: { id: 42, is_bot: false, first_name: "Guest", language_code: "zh-CN" },
        text: "帮我画一只猫",
      },
    } as never);

    expect(client.resolveAPIKey).not.toHaveBeenCalled();
    expect(mediaStore.getJobByIdempotencyKey("message:42:8")).toBeNull();
    const sent = calls.find((call) => call.method === "sendMessage");
    expect(sent?.payload.text).toContain("APIMaster 账号");
    expect(JSON.stringify(sent?.payload.reply_markup)).toContain("register?next=/console/personal");
  });

  it("shows activation immediately for a newly attached guest image", async () => {
    mediaStore = new MediaStore(":memory:");
    const getSnapshot = vi.fn().mockRejectedValue(new ResolverError("telegram_not_bound"));
    const classify = vi.fn();
    const bot = createBot("123:test", {
      client: {} as APIMasterClient,
      chatCredentials: guestCredentials,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn(), getSnapshot },
      contexts: contextStubs(),
      router: { model: "gpt-5.4", classify } as unknown as IntentRouter,
      mediaStore,
      botToken: "123:test",
    });
    bot.botInfo = botInfo;
    const calls = installApi(bot);

    await bot.handleUpdate({
      update_id: 1004,
      message: {
        message_id: 9, date: 1_788_333_600,
        chat: { id: 42, type: "private", first_name: "Guest" },
        from: { id: 42, is_bot: false, first_name: "Guest", language_code: "zh-CN" },
        photo: [{ file_id: "guest-photo", file_unique_id: "guest-unique", width: 100, height: 100 }],
      },
    } as never);

    expect(getSnapshot).toHaveBeenCalledWith(42);
    expect(classify).not.toHaveBeenCalled();
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text).toContain("注册或登录");
  });

  it("does not send an implicit active image to the guest model for unrelated text", async () => {
    mediaStore = new MediaStore(":memory:");
    mediaStore.setActivePrivateImage({
      telegramUserId: 42, chatId: 42, messageId: 10,
      fileId: "active-photo", fileUniqueId: "active-unique", type: "photo",
      mimeType: "image/jpeg", mediaGroupId: null,
    });
    const classify = vi.fn().mockResolvedValue({
      intent: "chat", confidence: 0.99, instruction: "", media_source: "none",
      image_options: null, video_options: null, final_response: "当然可以聊天。",
      conversation_mode: "casual", onboarding_opportunity: false, profile_updates: null,
      missingRequired: [],
    });
    const bot = createBot("123:test", {
      client: {} as APIMasterClient,
      chatCredentials: guestCredentials,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn() },
      contexts: contextStubs(),
      router: { model: "gpt-5.4", classify } as unknown as IntentRouter,
      mediaStore,
      botToken: "123:test",
    });
    bot.botInfo = botInfo;
    const calls = installApi(bot);

    await bot.handleUpdate({
      update_id: 1005,
      message: {
        message_id: 11, date: 1_788_333_600,
        chat: { id: 42, type: "private", first_name: "Guest" },
        from: { id: 42, is_bot: false, first_name: "Guest", language_code: "zh-CN" },
        text: "今天过得怎么样？",
      },
    } as never);

    expect(classify.mock.calls[0]?.[2]).toEqual([]);
    expect(calls.some((call) => call.method === "getFile")).toBe(false);
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text).toBe("当然可以聊天。");
  });

  it("routes a bound user without a usable Token to the Token page for explicit media", async () => {
    mediaStore = new MediaStore(":memory:");
    const bot = createBot("123:test", {
      client: {} as APIMasterClient,
      logger: createLogger("silent"),
      settings: {
        getPreferences: vi.fn(),
        getSnapshot: vi.fn().mockRejectedValue(new ResolverError("no_usable_api_key")),
      },
      contexts: contextStubs(),
      mediaStore,
      botToken: "123:test",
    });
    bot.botInfo = botInfo;
    const calls = installApi(bot);

    await bot.handleUpdate({
      update_id: 1006,
      message: {
        message_id: 12, date: 1_788_333_600,
        chat: { id: 42, type: "private", first_name: "Guest" },
        from: { id: 42, is_bot: false, first_name: "Guest", language_code: "zh-CN" },
        text: "/image 一只猫",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      },
    } as never);

    expect(mediaStore.getJobByIdempotencyKey("message:42:12")).toBeNull();
    const sent = calls.find((call) => call.method === "sendMessage");
    expect(sent?.payload.text).toContain("API Token");
    expect(JSON.stringify(sent?.payload.reply_markup)).toContain("/console/tokens");
  });

  it("rechecks the user's Key before confirming a paid video draft", async () => {
    mediaStore = new MediaStore(":memory:");
    const draft = mediaStore.createDraft({
      telegramUserId: 42,
      chatId: 42,
      threadId: null,
      type: "video_generate",
      idempotencyKey: "message:42:20",
      requestMessageId: 20,
      model: "MiniMax-H3",
      instruction: "星空延时摄影",
      options: {
        durationSeconds: 4,
        aspectRatio: "16:9",
        resolution: "768P",
        mode: "text_to_video",
        locale: "zh-CN",
      },
    });
    const resolveAPIKey = vi.fn().mockRejectedValue(new ResolverError("no_usable_api_key"));
    const bot = createBot("123:test", {
      client: { resolveAPIKey } as unknown as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn() },
      contexts: contextStubs(),
      mediaStore,
      botToken: "123:test",
    });
    bot.botInfo = botInfo;
    const calls = installApi(bot);

    await bot.handleUpdate({
      update_id: 1007,
      callback_query: {
        id: "confirm-video",
        from: { id: 42, is_bot: false, first_name: "Guest", language_code: "zh-CN" },
        message: {
          message_id: 21, date: 1_788_333_600,
          chat: { id: 42, type: "private", first_name: "Guest" },
          from: botInfo,
          text: "视频生成草稿",
        },
        chat_instance: "guest-instance",
        data: `media:${draft.id}:generate`,
      },
    } as never);

    expect(resolveAPIKey).toHaveBeenCalledWith(42, "MiniMax-H3");
    expect(mediaStore.getJob(draft.id)?.status).toBe("draft");
    const sent = calls.find((call) => call.method === "sendMessage");
    expect(JSON.stringify(sent?.payload.reply_markup)).toContain("/console/tokens");
  });
});
