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

  function update(updateId: number, messageId: number, text: string) {
    return {
      update_id: updateId,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: "private", first_name: "Liz" },
        from: { id: 42, is_bot: false, first_name: "Liz", language_code: "zh-CN" },
        text,
      },
    } as never;
  }

  it("translates active private messages without invoking the normal router", async () => {
    const structuredResponse = vi.fn().mockResolvedValue({
      data: { source: "user_language", translated_text: "Hello" },
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

    await bot.handleUpdate(update(1, 1, "/tr"));
    await bot.handleUpdate(update(2, 2, "你好"));

    expect(structuredResponse).toHaveBeenCalledOnce();
    expect(router.classify).not.toHaveBeenCalled();
    const translationMarkup = calls.find((call) => call.method === "sendMessage" && call.payload.text === "Hello")?.payload.reply_markup;
    expect(JSON.stringify(translationMarkup)).toContain('"copy_text":{"text":"Hello"}');
    expect((translationMarkup as { inline_keyboard?: unknown[][] } | undefined)?.inline_keyboard?.[0]).toHaveLength(3);

    await bot.handleUpdate(update(3, 3, "/ntr"));
    expect(contexts.getActiveTranslationSession(42, 42)).toBeNull();
  });
});
