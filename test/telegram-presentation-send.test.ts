import { describe, expect, it, vi } from "vitest";

import { sendTelegramPresentationChunk } from "../src/telegram/bot.js";

describe("Telegram presentation delivery", () => {
  it("retries a rejected HTML message as plain text", async () => {
    const sent = { message_id: 3 };
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("Telegram rejected HTML"))
      .mockResolvedValueOnce(sent);
    const ctx = { api: { sendMessage } };
    const message = { message_id: 2, chat: { id: 1, type: "private" } };

    await expect(sendTelegramPresentationChunk(
      ctx as never,
      message as never,
      { html: "<b>重点</b>", plainText: "重点" },
    )).resolves.toBe(sent);

    expect(sendMessage).toHaveBeenNthCalledWith(1, 1, "<b>重点</b>", {
      parse_mode: "HTML",
      reply_parameters: { message_id: 2, allow_sending_without_reply: true },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, 1, "重点", {
      reply_parameters: { message_id: 2, allow_sending_without_reply: true },
    });
  });
});
