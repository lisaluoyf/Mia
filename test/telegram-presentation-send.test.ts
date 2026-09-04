import { describe, expect, it, vi } from "vitest";

import { sendTelegramPresentationChunk } from "../src/telegram/bot.js";
import type { TelegramRichPresentationChunk } from "../src/presentation/telegram-rich.js";

const message = { message_id: 2, chat: { id: 1, type: "private" } };

function chunk(): TelegramRichPresentationChunk {
  return {
    richMessage: { blocks: [{ type: "heading", size: 2, text: "重点" }] },
    richBlocks: [{ type: "heading", size: 2, text: "重点" }],
    plainText: "重点",
    htmlFallback: [{ html: "<b>重点</b>", plainText: "重点" }],
  };
}

describe("Telegram presentation delivery", () => {
  it("sends a native Rich Message first", async () => {
    const sent = { message_id: 3 };
    const sendRichMessage = vi.fn().mockResolvedValue(sent);
    const sendMessage = vi.fn();
    const ctx = { api: { sendRichMessage, sendMessage } };

    await expect(sendTelegramPresentationChunk(ctx as never, message as never, chunk())).resolves.toMatchObject({
      messages: [sent], mode: "rich_message", fallbackReasons: [],
    });
    expect(sendRichMessage).toHaveBeenCalledWith(1, chunk().richMessage, {
      reply_parameters: { message_id: 2, allow_sending_without_reply: true },
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("falls back from Rich Message to HTML", async () => {
    const sent = { message_id: 3 };
    const sendRichMessage = vi.fn().mockRejectedValue(new Error("Telegram rejected rich content"));
    const sendMessage = vi.fn().mockResolvedValue(sent);
    const ctx = { api: { sendRichMessage, sendMessage } };

    await expect(sendTelegramPresentationChunk(ctx as never, message as never, chunk())).resolves.toMatchObject({
      messages: [sent], mode: "html", fallbackReasons: ["send_rich_message_failed"],
    });
    expect(sendMessage).toHaveBeenCalledWith(1, "<b>重点</b>", {
      parse_mode: "HTML",
      reply_parameters: { message_id: 2, allow_sending_without_reply: true },
    });
  });

  it("falls back from rejected Rich Message and HTML to plain text", async () => {
    const sent = { message_id: 3 };
    const sendRichMessage = vi.fn().mockRejectedValue(new Error("Telegram rejected rich content"));
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("Telegram rejected HTML"))
      .mockResolvedValueOnce(sent);
    const ctx = { api: { sendRichMessage, sendMessage } };

    await expect(sendTelegramPresentationChunk(ctx as never, message as never, chunk())).resolves.toMatchObject({
      messages: [sent],
      mode: "plain_text",
      fallbackReasons: ["send_rich_message_failed", "send_html_message_failed"],
    });

    expect(sendMessage).toHaveBeenNthCalledWith(1, 1, "<b>重点</b>", {
      parse_mode: "HTML",
      reply_parameters: { message_id: 2, allow_sending_without_reply: true },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, 1, "重点", {
      reply_parameters: { message_id: 2, allow_sending_without_reply: true },
    });
  });
});
