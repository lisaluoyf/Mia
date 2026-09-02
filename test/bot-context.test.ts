import { describe, expect, it, vi } from "vitest";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import { createLogger } from "../src/logger.js";
import { createTextHandler } from "../src/telegram/bot.js";

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
    expect(contexts.saveMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -1001,
      messageId: 7,
      threadId: 12,
      text: "大家好",
    }));
    expect(reply).not.toHaveBeenCalled();
  });
});
