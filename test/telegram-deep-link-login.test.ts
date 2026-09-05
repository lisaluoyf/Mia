import { afterEach, describe, expect, it, vi } from "vitest";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import { createLogger } from "../src/logger.js";
import { MediaStore } from "../src/media/store.js";
import { createBot } from "../src/telegram/bot.js";

const botInfo = {
  id: 100, is_bot: true, first_name: "Mia", username: "apimasterai_bot",
  can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

describe("Telegram deep-link login", () => {
  let mediaStore: MediaStore | undefined;

  afterEach(() => {
    mediaStore?.close();
    mediaStore = undefined;
  });

  it("confirms a private login start and never sends the code to the model router", async () => {
    const confirmTelegramDeepLinkLogin = vi.fn().mockResolvedValue({
      kind: "confirmed",
      loginUrl: "https://apimaster.example/api/auth/telegram/deep-link/complete?code=test",
    });
    const classify = vi.fn();
    mediaStore = new MediaStore(":memory:");
    const bot = createBot("123:test", {
      client: { confirmTelegramDeepLinkLogin } as unknown as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn() },
      contexts: {
        upsertUser: vi.fn(), upsertChat: vi.fn(), upsertMember: vi.fn(), saveMessage: vi.fn(),
      },
      mediaStore,
      router: { model: "gpt-5.4", classify } as never,
      botToken: "123:test",
    });
    bot.botInfo = botInfo;
    let replyText: string | null = null;
    let replyMarkup: unknown = null;
    bot.api.config.use((_previous, method, payload) => {
      const data: unknown = payload;
      if (method === "sendMessage" && isRecord(data)) {
        const text = typeof data.text === "string" ? data.text : "";
        replyText = text;
        replyMarkup = data.reply_markup;
        return Promise.resolve({ ok: true, result: {
          message_id: 9, date: 1, chat: { id: 42, type: "private", first_name: "Lisa" },
          from: botInfo, text,
        } } as never);
      }
      return Promise.resolve({ ok: true, result: true } as never);
    });
    const code = "a".repeat(43);
    await bot.handleUpdate({ update_id: 1, message: {
      message_id: 7, date: 1, chat: { id: 42, type: "private", first_name: "Lisa" },
      from: { id: 42, is_bot: false, first_name: "Lisa", username: "lisa", language_code: "zh-CN" },
      text: `/start login_${code}`,
    } } as never);

    expect(confirmTelegramDeepLinkLogin).toHaveBeenCalledWith(expect.objectContaining({ code, telegramUserId: 42 }));
    expect(classify).not.toHaveBeenCalled();
    expect(replyText).toBe("已确认 Telegram。点击下方按钮登录 APIMaster。");
    expect(JSON.stringify(replyMarkup)).toContain("立即登录");
    expect(JSON.stringify(replyMarkup)).toContain("complete?code=test");
  });
});
