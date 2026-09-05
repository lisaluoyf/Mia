import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import { createLogger } from "../src/logger.js";
import { MediaStore } from "../src/media/store.js";
import { MediaWorker } from "../src/media/worker.js";
import { MAX_TELEGRAM_STICKER_BYTES } from "../src/stickers/service.js";

describe("sticker media delivery", () => {
  let store: MediaStore | undefined;
  let resultDirectory: string | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    if (resultDirectory) rmSync(resultDirectory, { recursive: true, force: true });
    resultDirectory = undefined;
    vi.unstubAllGlobals();
  });

  async function setup(createResult: true | "occupied" = true) {
    resultDirectory = mkdtempSync(join(tmpdir(), "mia-sticker-results-"));
    store = new MediaStore(":memory:", { resultDirectory });
    const claimed = store.claimJob({
      telegramUserId: 42,
      chatId: 42,
      threadId: null,
      type: "image_edit",
      idempotencyKey: "message:42:7",
      requestMessageId: 7,
      statusMessageId: 8,
      model: "gpt-image-2",
      instruction: "Create one sticker",
      options: { aspectRatio: "1:1", locale: "zh-CN", outputMode: "telegram_sticker", stickerTitle: "Liz | Mia" },
    }, [{
      position: 0,
      messageId: 7,
      fileId: "source-photo",
      fileUniqueId: "source-unique",
      type: "photo",
      mimeType: "image/jpeg",
      mediaGroupId: null,
    }]);
    if (claimed.outcome !== "created") throw new Error("Expected media job creation");
    const generated = await sharp({
      create: { width: 768, height: 512, channels: 4, background: { r: 10, g: 120, b: 220, alpha: 0.7 } },
    }).png().toBuffer();
    const createNewStickerSet = createResult === "occupied"
      ? vi.fn().mockRejectedValue({ description: "Bad Request: sticker set name is already occupied" })
      : vi.fn().mockResolvedValue(true);
    const getStickerSet = vi.fn().mockResolvedValue({
      name: "set",
      title: "Liz | Mia",
      sticker_type: "regular",
      stickers: [{ file_id: "sticker-file", file_unique_id: "sticker-unique" }],
    });
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 9,
      sticker: { file_id: "sticker-file", file_unique_id: "sticker-unique" },
    });
    const deleteMessage = vi.fn().mockResolvedValue(true);
    const worker = new MediaWorker({
      client: {
        resolveAPIKey: vi.fn().mockResolvedValue("user-key"),
        submitImage: vi.fn().mockResolvedValue({
          kind: "result",
          state: {
            status: "succeeded",
            progress: 100,
            resultUrl: null,
            resultBase64: generated.toString("base64"),
            errorCode: null,
          },
        }),
      } as unknown as APIMasterClient,
      store,
      api: {
        getFile: vi.fn().mockResolvedValue({ file_path: "photos/source.jpg", file_size: generated.length }),
        createNewStickerSet,
        getStickerSet,
        sendSticker,
        deleteMessage,
        editMessageText: vi.fn(),
      } as unknown as Api,
      botToken: "123:test",
      botUsername: "MiaAssistantBot",
      logger: createLogger("silent"),
      intervalMs: 1_000,
      resultMaxBytes: 10_000_000,
      publicBaseUrl: null,
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(generated, {
      headers: { "content-type": "image/jpeg" },
    })));
    return { worker, createNewStickerSet, getStickerSet, sendSticker, deleteMessage, job: claimed.job };
  }

  it("creates a sender-owned pack, sends its real sticker, and stores a valid WebP", async () => {
    const { worker, createNewStickerSet, getStickerSet, sendSticker, deleteMessage, job } = await setup();

    await worker.tick();

    expect(createNewStickerSet).toHaveBeenCalledWith(
      42,
      expect.stringMatching(/^mia_.*_by_MiaAssistantBot$/),
      "Liz | Mia",
      [expect.objectContaining({ format: "static", emoji_list: ["👍"] })],
      { sticker_type: "regular" },
    );
    const setName = createNewStickerSet.mock.calls[0]?.[1] as string;
    expect(getStickerSet).toHaveBeenCalledWith(setName);
    expect(sendSticker).toHaveBeenCalledWith(42, "sticker-file", expect.not.objectContaining({
      reply_parameters: expect.anything() as unknown,
    }));
    expect(deleteMessage).toHaveBeenCalledWith(42, 8);
    expect(sendSticker.mock.invocationCallOrder[0]).toBeLessThan(deleteMessage.mock.invocationCallOrder[0] ?? 0);
    const replyMarkup = JSON.stringify(sendSticker.mock.calls[0]?.[2]);
    expect(replyMarkup).toContain(`https://t.me/addstickers/${setName}`);
    expect(replyMarkup).toContain(`media:${job.id}:again`);
    expect(replyMarkup).toContain(`media:${job.id}:edit`);
    expect(store?.getJob(job.id)).toMatchObject({
      status: "succeeded",
      resultMimeType: "image/webp",
      resultTelegramFileId: "sticker-file",
    });
    const stored = store?.readLocalResult(job.id, "image/webp");
    const metadata = await sharp(stored?.bytes).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 512, height: 512, hasAlpha: true });
    expect(stored?.size).toBeLessThanOrEqual(MAX_TELEGRAM_STICKER_BYTES);
    expect(store?.getTelegramMedia(42, 9)).toMatchObject([{
      fileId: "sticker-file",
      type: "document",
      mimeType: "image/webp",
    }]);
  });

  it("reuses the deterministic pack when a delivery retry finds its name occupied", async () => {
    const { worker, createNewStickerSet, getStickerSet, sendSticker } = await setup("occupied");

    await worker.tick();

    expect(createNewStickerSet).toHaveBeenCalledOnce();
    expect(getStickerSet).toHaveBeenCalledOnce();
    expect(sendSticker).toHaveBeenCalledOnce();
    expect(store?.getJobByIdempotencyKey("message:42:7")?.status).toBe("succeeded");
  });
});
