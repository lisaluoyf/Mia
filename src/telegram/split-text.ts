import { TELEGRAM_MESSAGE_LIMIT } from "../constants.js";

export function splitText(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (limit < 1) {
    throw new RangeError("limit must be positive");
  }

  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const boundary = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const splitAt = boundary > 0 ? boundary : limit;
    const chunk = remaining.slice(0, splitAt).trimEnd();
    chunks.push(chunk || remaining.slice(0, limit));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}
