import { GrammyError, type Api } from "grammy";
import type { Message } from "grammy/types";
import type { TelegramRichPresentationChunk } from "../presentation/telegram-rich.js";

export function formatRejected(error: unknown): boolean {
  return error instanceof GrammyError && [400, 404, 405, 501].includes(error.error_code);
}

// Fallback is safe only after a definite rejection, not a transport failure.
export async function sendAgentChunk(
  api: Api, chatId: number, chunk: TelegramRichPresentationChunk,
  options: Record<string, unknown>,
  sendOnce: (suffix: string, send: () => Promise<Message>) => Promise<void>,
  current: () => boolean,
): Promise<void> {
  try {
    await sendOnce("rich", () => api.sendRichMessage(chatId, chunk.richMessage, options));
    return;
  } catch (error) { if (!formatRejected(error)) throw error; }
  for (const [index, fallback] of chunk.htmlFallback.entries()) {
    if (!current()) return;
    try {
      await sendOnce(`html:${index}`, () => api.sendMessage(chatId, fallback.html, { ...options, parse_mode: "HTML" }));
    } catch (error) {
      if (!formatRejected(error)) throw error;
      if (!current()) return;
      await sendOnce(`plain:${index}`, () => api.sendMessage(chatId, fallback.plainText, options));
    }
  }
}
