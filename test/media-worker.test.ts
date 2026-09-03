import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import { MediaAPIError } from "../src/clients/apimaster.js";
import { createLogger } from "../src/logger.js";
import { MediaStore } from "../src/media/store.js";
import { MediaWorker } from "../src/media/worker.js";

describe("media worker transient regeneration status", () => {
  let store: MediaStore | undefined;
  let resultDirectory: string | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    if (resultDirectory) rmSync(resultDirectory, { recursive: true, force: true });
    resultDirectory = undefined;
    vi.unstubAllGlobals();
  });

  function createJob() {
    resultDirectory = mkdtempSync(join(tmpdir(), "mia-worker-results-"));
    store = new MediaStore(":memory:", { resultDirectory });
    const claimed = store.claimJob({
      telegramUserId: 42,
      chatId: 42,
      threadId: null,
      type: "image_generate",
      idempotencyKey: "callback:again-1",
      requestMessageId: 77,
      statusMessageId: 78,
      model: "gpt-image-2",
      instruction: "A moonlit portrait",
      options: { aspectRatio: "1:1", locale: "zh-CN", ephemeralStatus: true },
    });
    if (claimed.outcome !== "created") throw new Error("Expected media job creation");
    return claimed.job;
  }

  it("keeps the progress text through submission and deletes it after sending the new image", async () => {
    createJob();
    const editMessageText = vi.fn().mockResolvedValue({});
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 79,
      photo: [{ file_id: "new-photo", file_unique_id: "new-unique", width: 1024, height: 1024 }],
    });
    const deleteMessage = vi.fn().mockResolvedValue(true);
    const client = {
      resolveAPIKey: vi.fn().mockResolvedValue("user-key"),
      submitImage: vi.fn().mockResolvedValue({ kind: "task", taskId: "task-2" }),
      pollImage: vi.fn().mockResolvedValue({
        status: "succeeded",
        progress: 100,
        resultBase64: Buffer.from("image").toString("base64"),
      }),
    };
    const worker = new MediaWorker({
      client: client as unknown as APIMasterClient,
      store,
      api: { editMessageText, sendPhoto, deleteMessage } as unknown as Api,
      botToken: "123:test",
      logger: createLogger("silent"),
      intervalMs: 1_000,
      resultMaxBytes: 10_000_000,
      publicBaseUrl: null,
      botUsername: "MiaAssistantBot",
    });

    await worker.tick();
    expect(store.getJobByIdempotencyKey("callback:again-1")?.status).toBe("submitted");
    expect(editMessageText).not.toHaveBeenCalled();

    await worker.tick();
    expect(sendPhoto).toHaveBeenCalledWith(42, expect.anything(), expect.objectContaining({
      reply_parameters: { message_id: 77, allow_sending_without_reply: true },
    }));
    expect(deleteMessage).toHaveBeenCalledWith(42, 78);
    expect(sendPhoto.mock.invocationCallOrder[0]).toBeLessThan(deleteMessage.mock.invocationCallOrder[0] ?? 0);
    expect(store.getJobByIdempotencyKey("callback:again-1")).toMatchObject({
      status: "succeeded",
      statusMessageId: 79,
      resultTelegramFileId: "new-photo",
    });
    expect(Buffer.from(store.readLocalResult(1, "image/png")?.bytes ?? []).toString("utf8")).toBe("image");
  });

  it("replaces the progress text with an error when submission fails", async () => {
    createJob();
    const editMessageText = vi.fn().mockResolvedValue({});
    const sendMessage = vi.fn().mockResolvedValue({});
    const worker = new MediaWorker({
      client: {
        resolveAPIKey: vi.fn().mockResolvedValue("user-key"),
        submitImage: vi.fn().mockRejectedValue(new Error("upstream unavailable")),
      } as unknown as APIMasterClient,
      store,
      api: { editMessageText, sendMessage } as unknown as Api,
      botToken: "123:test",
      logger: createLogger("silent"),
      intervalMs: 1_000,
      resultMaxBytes: 10_000_000,
      publicBaseUrl: null,
      botUsername: "MiaAssistantBot",
    });

    await worker.tick();

    expect(editMessageText).toHaveBeenCalledWith(42, 78, "媒体请求提交失败，Mia 没有自动重试，以免重复扣费。", {
      reply_markup: { inline_keyboard: [] },
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.getJobByIdempotencyKey("callback:again-1")?.status).toBe("failed");
  });

  it("shows a wallet button when APIMaster rejects media before charging", async () => {
    createJob();
    const editMessageText = vi.fn().mockResolvedValue({});
    const submitImage = vi.fn().mockRejectedValue(new MediaAPIError("insufficient_quota", 402));
    const worker = new MediaWorker({
      client: {
        resolveAPIKey: vi.fn().mockResolvedValue("user-key"),
        submitImage,
      } as unknown as APIMasterClient,
      store,
      api: { editMessageText, sendMessage: vi.fn() } as unknown as Api,
      botToken: "123:test",
      logger: createLogger("silent"),
      intervalMs: 1_000,
      resultMaxBytes: 10_000_000,
      publicBaseUrl: null,
      botUsername: "MiaAssistantBot",
    });

    await worker.tick();

    expect(submitImage).toHaveBeenCalledOnce();
    expect(store.getJobByIdempotencyKey("callback:again-1")).toMatchObject({
      status: "failed",
      upstreamTaskId: null,
      errorCode: "insufficient_quota",
    });
    expect(editMessageText).toHaveBeenCalledWith(
      42,
      78,
      expect.stringContaining("余额不足"),
      expect.anything(),
    );
    expect(JSON.stringify(editMessageText.mock.calls[0]?.[3])).toContain("https://apimaster.ai/console/wallet");
  });

  it("delivers a synchronous image-edit result without polling", async () => {
    resultDirectory = mkdtempSync(join(tmpdir(), "mia-worker-results-"));
    store = new MediaStore(":memory:", { resultDirectory });
    const claimed = store.claimJob({
      telegramUserId: 42,
      chatId: 42,
      threadId: null,
      type: "image_edit",
      idempotencyKey: "message:edit-1",
      requestMessageId: 80,
      statusMessageId: 81,
      model: "gpt-image-2",
      instruction: "Remove the overlay",
      options: { aspectRatio: "1:1", locale: "zh-CN" },
    }, [{
      position: 0,
      messageId: 79,
      fileId: "source-photo",
      fileUniqueId: "source-unique",
      type: "photo",
      mimeType: "image/png",
      mediaGroupId: null,
    }]);
    expect(claimed.outcome).toBe("created");
    const source = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
    }).png().toBuffer();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(source, {
      headers: { "content-type": "image/png" },
    })));
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 82,
      photo: [{ file_id: "edited-photo", file_unique_id: "edited-unique", width: 1024, height: 1024 }],
    });
    const deleteMessage = vi.fn().mockResolvedValue(true);
    const pollImage = vi.fn();
    const worker = new MediaWorker({
      client: {
        resolveAPIKey: vi.fn().mockResolvedValue("user-key"),
        submitImage: vi.fn().mockResolvedValue({
          kind: "result",
          state: {
            status: "succeeded",
            progress: 100,
            resultUrl: null,
            resultBase64: source.toString("base64"),
            errorCode: null,
          },
        }),
        pollImage,
      } as unknown as APIMasterClient,
      store,
      api: {
        getFile: vi.fn().mockResolvedValue({ file_path: "photos/source.png", file_size: source.length }),
        sendPhoto,
        deleteMessage,
        editMessageText: vi.fn(),
      } as unknown as Api,
      botToken: "123:test",
      logger: createLogger("silent"),
      intervalMs: 1_000,
      resultMaxBytes: 10_000_000,
      publicBaseUrl: null,
      botUsername: "MiaAssistantBot",
    });

    await worker.tick();

    expect(pollImage).not.toHaveBeenCalled();
    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(deleteMessage).toHaveBeenCalledWith(42, 81);
    expect(sendPhoto.mock.invocationCallOrder[0]).toBeLessThan(deleteMessage.mock.invocationCallOrder[0] ?? 0);
    expect(store.getJobByIdempotencyKey("message:edit-1")).toMatchObject({
      status: "succeeded",
      upstreamTaskId: null,
      statusMessageId: 82,
      resultTelegramFileId: "edited-photo",
    });
  });
});
