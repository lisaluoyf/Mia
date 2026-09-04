import type { Api } from "grammy";
import type { Message } from "grammy/types";

export type TelegramTextMessage = Message.TextMessage | Message.RichMessageMessage;

function validMessage(value: unknown): value is TelegramTextMessage {
  return typeof value === "object" && value !== null && "message_id" in value &&
    typeof value.message_id === "number";
}

export async function sendTelegramRichText(
  api: Api,
  chatId: number | string,
  text: string,
  options: Record<string, unknown> = {},
): Promise<TelegramTextMessage> {
  try {
    const sent = await api.sendRichMessage(
      chatId,
      { blocks: [{ type: "paragraph", text }] },
      options,
    );
    if (!validMessage(sent)) throw new Error("invalid_rich_message_response");
    return sent;
  } catch {
    const sent = await api.sendMessage(chatId, text, options);
    if (!validMessage(sent)) throw new Error("invalid_plain_message_response");
    return sent;
  }
}
