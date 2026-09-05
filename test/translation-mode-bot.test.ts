import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import type { ChatCredentialProvider } from "../src/credentials/chat.js";
import { createLogger } from "../src/logger.js";
import { MediaStore } from "../src/media/store.js";
import { ContextStore } from "../src/storage/store.js";
import { createBot } from "../src/telegram/bot.js";

const botInfo = { id: 100, is_bot: true, first_name: "Mia", username: "MiaAssistantBot" };

describe("private translation mode", () => {
  let contexts: ContextStore;
  let mediaStore: MediaStore;

  beforeEach(() => {
    contexts = new ContextStore(":memory:");
    mediaStore = new MediaStore(":memory:");
  });

  afterEach(() => {
    contexts.close();
    mediaStore.close();
  });

  function update(updateId: number, messageId: number, text: string, languageCode = "zh-CN") {
    return {
      update_id: updateId,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: "private", first_name: "Liz" },
        from: { id: 42, is_bot: false, first_name: "Liz", language_code: languageCode },
        text,
      },
    } as never;
  }

  function callbackUpdate(updateId: number, data: string, text: string) {
    return {
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        from: { id: 42, is_bot: false, first_name: "Liz", language_code: "zh-CN" },
        chat_instance: "translation-test",
        data,
        message: {
          message_id: 500,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 42, type: "private", first_name: "Liz" },
          from: botInfo,
          text,
        },
      },
    } as never;
  }

  it("translates active private messages without invoking the normal router", async () => {
    const structuredResponse = vi.fn()
      .mockResolvedValueOnce({
        data: { source: "left_language", translated_text: "Hello" },
        webSearch: { callCount: 0, queries: [], sources: [] },
      })
      .mockResolvedValueOnce({
        data: { source: "right_language", translated_text: "\u4f60\u597d" },
        webSearch: { callCount: 0, queries: [], sources: [] },
      });
    const router = { classify: vi.fn(), model: "gpt-5.4" };
    const credentials: ChatCredentialProvider = {
      resolve: vi.fn().mockResolvedValue({ apiKey: "user-key", model: "gpt-5.4", source: "user", fallbackReason: null }),
    };
    const bot = createBot("123:test", {
      client: { structuredResponse, resolveAPIKey: vi.fn() } as unknown as APIMasterClient,
      chatCredentials: credentials,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn().mockReturnValue({ chatModel: "gpt-5.4" }) },
      contexts,
      router: router as never,
      mediaStore,
      botToken: "123:test",
    });
    bot.botInfo = botInfo as never;
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    bot.api.config.use((_previous, method, payload) => {
      const data = payload as unknown as Record<string, unknown>;
      calls.push({ method, payload: data });
      if (method === "sendRichMessage") return Promise.reject(new Error("unsupported"));
      if (method === "sendChatAction") return Promise.resolve({ ok: true, result: true } as never);
      return Promise.resolve({ ok: true, result: {
        message_id: 200 + calls.length,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: "private", first_name: "Liz" },
        from: botInfo,
        text: typeof data.text === "string" ? data.text : "",
      } } as never);
    });

    await bot.handleUpdate(update(1, 1, "/tr Japanese"));
    expect(contexts.getActiveTranslationSession(42, 42)).toMatchObject({
      leftLanguage: "zh-CN",
      rightLanguage: "ja",
    });
    expect(calls.some((call) => call.method === "sendRichMessage")).toBe(false);
    await bot.handleUpdate(update(2, 2, "你好"));

    expect(structuredResponse).toHaveBeenCalledOnce();
    expect(router.classify).not.toHaveBeenCalled();
    const translationMarkup = calls.find((call) => call.method === "sendMessage" && call.payload.text === "Hello")?.payload.reply_markup;
    expect(JSON.stringify(translationMarkup)).toContain('"copy_text":{"text":"Hello"}');
    expect((translationMarkup as { inline_keyboard?: unknown[][] } | undefined)?.inline_keyboard?.[0]).toHaveLength(3);

    await bot.handleUpdate(update(3, 3, "Hello"));

    expect(structuredResponse).toHaveBeenCalledTimes(2);
    const reverseTranslationMarkup = calls.find((call) => call.method === "sendMessage" && call.payload.text === "\u4f60\u597d")?.payload.reply_markup;
    expect(JSON.stringify(reverseTranslationMarkup)).toContain('"copy_text":{"text":"\u4f60\u597d"}');
    expect((reverseTranslationMarkup as { inline_keyboard?: unknown[][] } | undefined)?.inline_keyboard?.[0]).toHaveLength(3);

    await bot.handleUpdate(callbackUpdate(4, "translation:switch:42", "\u4f60\u597d"));

    const pairEditor = calls.find((call) =>
      call.method === "sendMessage" && call.payload.text === "\u9009\u62e9\u8bed\u8a00\u5bf9\uff1a");
    const pairEditorRows = (pairEditor?.payload.reply_markup as { inline_keyboard?: Array<Array<{ text?: string }>> } | undefined)?.inline_keyboard;
    expect(pairEditorRows?.[0]?.map((button) => button.text)).toEqual(["\u4e2d\u6587", "\u65e5\u8bed"]);
    expect(calls.some((call) => call.method === "editMessageText")).toBe(false);
    expect(calls.some((call) => call.method === "editMessageReplyMarkup")).toBe(true);

    await bot.handleUpdate(callbackUpdate(5, "translation:pair:42:side:left", "\u9009\u62e9\u8bed\u8a00\u5bf9\uff1a"));
    expect(calls.some((call) => call.method === "sendMessage" && call.payload.text === "\u9009\u62e9\u5de6\u4fa7\u8bed\u8a00\uff1a")).toBe(false);
    const pickerEdit = calls.filter((call) => call.method === "editMessageReplyMarkup").at(-1);
    const pickerRows = (pickerEdit?.payload.reply_markup as { inline_keyboard?: Array<Array<{ text?: string }>> } | undefined)?.inline_keyboard;
    expect(pickerRows?.slice(0, 4).flat()).toHaveLength(8);

    await bot.handleUpdate(callbackUpdate(6, "translation:pair:42:page:left:1", "\u9009\u62e9\u8bed\u8a00\u5bf9\uff1a"));
    const pageEdit = calls.filter((call) => call.method === "editMessageReplyMarkup").at(-1);
    const pageRows = (pageEdit?.payload.reply_markup as { inline_keyboard?: Array<Array<{ text?: string }>> } | undefined)?.inline_keyboard;
    expect(pageRows?.slice(0, 4).flat()).toHaveLength(8);

    await bot.handleUpdate(callbackUpdate(7, "translation:pair:42:set:left:ja", "\u9009\u62e9\u8bed\u8a00\u5bf9\uff1a"));
    expect(contexts.getActiveTranslationSession(42, 42)).toMatchObject({ leftLanguage: "ja", rightLanguage: "zh-CN" });
    const savedPairEdit = calls.filter((call) => call.method === "editMessageReplyMarkup").at(-1);
    const savedPairRows = (savedPairEdit?.payload.reply_markup as { inline_keyboard?: Array<Array<{ text?: string }>> } | undefined)?.inline_keyboard;
    expect(savedPairRows?.[0]?.map((button) => button.text)).toEqual(["\u65e5\u8bed", "\u4e2d\u6587"]);

    await bot.handleUpdate(callbackUpdate(8, "translation:exit:42", "\u9009\u62e9\u8bed\u8a00\u5bf9\uff1a"));
    expect(calls.some((call) =>
      call.method === "sendMessage" && call.payload.text === "\u7ffb\u8bd1\u6a21\u5f0f\u5df2\u9000\u51fa\u3002")).toBe(true);
    expect(calls.some((call) => call.method === "editMessageText")).toBe(false);
    expect(contexts.getActiveTranslationSession(42, 42)).toBeNull();

    await bot.handleUpdate(update(9, 9, "/tr"));
    expect(contexts.getActiveTranslationSession(42, 42)).toMatchObject({
      leftLanguage: "ja",
      rightLanguage: "zh-CN",
    });
  });

  it("uses the Telegram language for users outside the old fixed language pairs", async () => {
    const bot = createBot("123:test", {
      client: { structuredResponse: vi.fn(), resolveAPIKey: vi.fn() } as unknown as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn().mockReturnValue({ chatModel: "gpt-5.4" }) },
      contexts,
      mediaStore,
      botToken: "123:test",
    });
    bot.botInfo = botInfo as never;
    bot.api.config.use((_previous, _method, payload) => Promise.resolve({ ok: true, result: {
      message_id: 300,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: "private", first_name: "Liz" },
      from: botInfo,
      text: typeof (payload as { text?: unknown }).text === "string" ? (payload as { text: string }).text : "",
    } } as never));

    await bot.handleUpdate(update(1, 1, "/tr", "es"));

    expect(contexts.getActiveTranslationSession(42, 42)).toMatchObject({
      leftLanguage: "es",
      rightLanguage: "en",
    });
  });

  it("normalizes legacy language names before translating an existing session", async () => {
    contexts.upsertUser({ telegramUserId: 42, firstName: "Liz", lastName: null, username: null, languageCode: "zh-CN", isBot: false });
    contexts.upsertChat({ chatId: 42, type: "private", title: null, username: null, description: null, isForum: false });
    contexts.enterTranslationSession(42, 42, "Simplified Chinese", "English");
    const requestContents: string[] = [];
    const structuredResponse = vi.fn((_apiKey: string, _model: string, messages: Array<{ content: string }>) => {
      requestContents.push(messages.at(-1)?.content ?? "");
      return Promise.resolve({
        data: { source: "left_language", translated_text: "Hello" },
        webSearch: { callCount: 0, queries: [], sources: [] },
      });
    });
    const credentials: ChatCredentialProvider = {
      resolve: vi.fn().mockResolvedValue({ apiKey: "user-key", model: "gpt-5.4", source: "user", fallbackReason: null }),
    };
    const bot = createBot("123:test", {
      client: { structuredResponse, resolveAPIKey: vi.fn() } as unknown as APIMasterClient,
      chatCredentials: credentials,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn().mockReturnValue({ chatModel: "gpt-5.4" }) },
      contexts,
      mediaStore,
      botToken: "123:test",
    });
    bot.botInfo = botInfo as never;
    bot.api.config.use((_previous, method, payload) => {
      if (method === "sendChatAction") return Promise.resolve({ ok: true, result: true } as never);
      return Promise.resolve({ ok: true, result: {
        message_id: 400,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: "private", first_name: "Liz" },
        from: botInfo,
        text: typeof (payload as { text?: unknown }).text === "string" ? (payload as { text: string }).text : "",
      } } as never);
    });

    await bot.handleUpdate(update(1, 1, "\u4f60\u597d"));

    expect(requestContents.join("\n")).toContain('"left_language":"zh-CN"');
    expect(contexts.getActiveTranslationSession(42, 42)).toMatchObject({ leftLanguage: "zh-CN", rightLanguage: "en" });
  });
});
