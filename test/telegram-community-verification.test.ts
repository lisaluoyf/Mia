import { afterEach, describe, expect, it, vi } from "vitest";

import type { APIMasterClient, TelegramCommunityVerification } from "../src/clients/apimaster.js";
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

describe("Telegram community verification", () => {
  let mediaStore: MediaStore | undefined;

  afterEach(() => {
    mediaStore?.close();
    mediaStore = undefined;
  });

  async function runVerification(result: TelegramCommunityVerification, payload = `verify_${"a".repeat(43)}`) {
    const consumeTelegramCommunityVerification = vi.fn().mockResolvedValue(result);
    const classify = vi.fn();
    mediaStore = new MediaStore(":memory:");
    const bot = createBot("123:test", {
      client: { consumeTelegramCommunityVerification } as unknown as APIMasterClient,
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
    const replies: Array<{ text: string; replyMarkup: unknown }> = [];
    bot.api.config.use((_previous, method, payload) => {
      const data: unknown = payload;
      if (method === "sendMessage" && isRecord(data)) {
        const text = typeof data.text === "string" ? data.text : "";
        replies.push({ text, replyMarkup: data.reply_markup });
        return Promise.resolve({ ok: true, result: {
          message_id: 9, date: 1, chat: { id: 42, type: "private", first_name: "Lisa" },
          from: botInfo, text,
        } } as never);
      }
      return Promise.resolve({ ok: true, result: true } as never);
    });
    await bot.handleUpdate({ update_id: 1, message: {
      message_id: 7, date: 1, chat: { id: 42, type: "private", first_name: "Lisa" },
      from: { id: 42, is_bot: false, first_name: "Lisa", username: "lisa", language_code: "zh-CN" },
      text: `/start ${payload}`,
    } } as never);
    return { classify, consumeTelegramCommunityVerification, replies };
  }

  it("confirms verification with a community button without routing the token to a model", async () => {
    const result = await runVerification({ kind: "confirmed", groupUrl: "https://t.me/apimaster_test" });

    expect(result.consumeTelegramCommunityVerification).toHaveBeenCalledWith("a".repeat(43), 42);
    expect(result.classify).not.toHaveBeenCalled();
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.text).toBe("验证完成，现在可以加入 APIMaster 社群。");
    expect(JSON.stringify(result.replies[0]?.replyMarkup)).toContain("加入社群");
    expect(JSON.stringify(result.replies[0]?.replyMarkup)).toContain("https://t.me/apimaster_test");
  });

  it("does not reply to an idempotent replay", async () => {
    const result = await runVerification({ kind: "replay" });

    expect(result.consumeTelegramCommunityVerification).toHaveBeenCalledOnce();
    expect(result.classify).not.toHaveBeenCalled();
    expect(result.replies).toEqual([]);
  });

  it.each([
    [{ kind: "invalid_or_expired" } as const, "这个验证链接无效或已过期，请返回 APIMaster 获取新链接。"],
    [{ kind: "telegram_already_linked" } as const, "这个 Telegram 账号已经绑定到另一个 APIMaster 账号。"],
    [{ kind: "unavailable", status: 503 } as const, "社群验证暂时不可用，请稍后重试。"],
  ])("handles %s without invoking the model router", async (verification, expectedText) => {
    const result = await runVerification(verification);

    expect(result.classify).not.toHaveBeenCalled();
    expect(result.replies.map((reply) => reply.text)).toEqual([expectedText]);
  });

  it("rejects malformed verification payloads before calling APIMaster", async () => {
    const result = await runVerification(
      { kind: "confirmed", groupUrl: "https://t.me/apimaster_test" },
      `verify_${"a".repeat(42)}!`,
    );

    expect(result.consumeTelegramCommunityVerification).not.toHaveBeenCalled();
  });
});
