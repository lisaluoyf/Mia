import { describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  isStickerRequest,
  isStickerSetNameOccupied,
  MAX_TELEGRAM_STICKER_BYTES,
  prepareTelegramSticker,
  stickerSetName,
} from "../src/stickers/service.js";

describe("sticker helpers", () => {
  it("requires explicit sticker intent", () => {
    expect(isStickerRequest("做成贴纸")).toBe(true);
    expect(isStickerRequest("生成一个表情包")).toBe(true);
    expect(isStickerRequest("make a sticker")).toBe(true);
    expect(isStickerRequest("看看这张照片")).toBe(false);
    expect(isStickerRequest(undefined)).toBe(false);
  });

  it("builds a deterministic valid Telegram sticker set name", () => {
    const name = stickerSetName(9_007_199_254_740_991, 9_007_199_254_740_991, "MiaAssistantBot");
    expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
    expect(name).toMatch(/_by_MiaAssistantBot$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(stickerSetName(42, 7, "MiaAssistantBot")).toBe(stickerSetName(42, 7, "MiaAssistantBot"));
  });

  it("recognizes only Telegram's occupied-name error as recoverable", () => {
    expect(isStickerSetNameOccupied({ description: "Bad Request: sticker set name is already occupied" })).toBe(true);
    expect(isStickerSetNameOccupied(new Error("network unavailable"))).toBe(false);
  });

  it("normalizes an image to a Telegram-compatible WebP", async () => {
    const source = await sharp({
      create: { width: 900, height: 600, channels: 4, background: { r: 120, g: 80, b: 200, alpha: 0.8 } },
    }).png().toBuffer();

    const sticker = await prepareTelegramSticker(source);
    const metadata = await sharp(sticker).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);
    expect(metadata.hasAlpha).toBe(true);
    expect(sticker.byteLength).toBeLessThanOrEqual(MAX_TELEGRAM_STICKER_BYTES);
  });
});
