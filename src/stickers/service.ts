import sharp from "sharp";

export const MAX_TELEGRAM_STICKER_BYTES = 512 * 1024;

const STICKER_INTENT_PATTERN = /(?:贴纸|表情包|sticker)/iu;

export function isStickerRequest(text: string | undefined): boolean {
  return STICKER_INTENT_PATTERN.test(text ?? "");
}

export function stickerPrompt(text: string | undefined): string {
  const request = text?.trim() || "Turn the subject into a sticker.";
  return [
    "Turn the main subject in the reference image into one polished Telegram sticker.",
    `User request: ${request}`,
    "Preserve the subject's identity, colors, and distinctive features.",
    "Use a transparent background, a clean thick white outline, and generous padding.",
    "Center one subject only. Do not add text, a frame, a grid, or extra objects.",
  ].join(" ");
}

export function stickerSetName(userId: number, jobId: number, botUsername: string): string {
  const username = botUsername.replace(/[^a-zA-Z0-9_]/g, "");
  if (!username || username.length > 32) throw new Error("invalid_bot_username");
  const name = `mia_${userId.toString(36)}_${jobId.toString(36)}_by_${username}`;
  if (name.length > 64) throw new Error("sticker_set_name_too_long");
  return name;
}

export function stickerSetTitle(firstName: string): string {
  return `${Array.from(firstName).slice(0, 40).join("")} | Mia`;
}

export async function prepareTelegramSticker(source: Uint8Array): Promise<Buffer> {
  for (const quality of [90, 80, 70, 60, 50, 40, 30]) {
    const output = await sharp(source)
      .rotate()
      .resize(512, 512, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        withoutEnlargement: false,
      })
      .webp({ quality, alphaQuality: 100 })
      .toBuffer();
    if (output.byteLength <= MAX_TELEGRAM_STICKER_BYTES) return output;
  }
  throw new Error("sticker_too_large");
}

export function isStickerSetNameOccupied(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const description = "description" in error && typeof error.description === "string"
    ? error.description
    : "message" in error && typeof error.message === "string"
      ? error.message
      : "";
  return /sticker.*(?:name.*occupied|set.*already)|name is already occupied/i.test(description);
}
