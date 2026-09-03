import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../src/logger.js";
import { MediaWorker } from "../src/media/worker.js";
import type { MediaJob } from "../src/media/types.js";

const job: MediaJob = {
  id: 7,
  telegramUserId: 123,
  chatId: 123,
  threadId: null,
  type: "image_generate",
  idempotencyKey: "update:1",
  requestMessageId: 10,
  statusMessageId: 11,
  model: "image-model",
  instruction: "draw a lighthouse",
  options: { locale: "en" },
  status: "submitted",
  upstreamTaskId: "task-1",
  progress: null,
  resultUrl: null,
  resultMimeType: null,
  resultTelegramFileId: null,
  resultTelegramUniqueId: null,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  submittedAt: "2026-09-02T00:00:00.000Z",
  completedAt: null,
  deadlineAt: "2026-09-02T00:15:00.000Z",
  retentionExpiresAt: "2026-09-09T00:00:00.000Z",
};

interface CapturedSendPhotoOptions {
  reply_markup: {
    inline_keyboard: Array<Array<Record<string, string>>>;
  };
}

function createWorker(publicBaseUrl: string | null) {
  const sendPhoto = vi.fn<(
    chatId: number,
    photo: unknown,
    options: CapturedSendPhotoOptions,
  ) => Promise<{ message_id: number; photo: Array<{ file_id: string; file_unique_id: string }> }>>().mockResolvedValue({
    message_id: 12,
    photo: [{ file_id: "telegram-file", file_unique_id: "telegram-unique" }],
  });
  const store = {
    listTimedOutJobs: vi.fn().mockReturnValue([]),
    listRetentionExpiredJobs: vi.fn().mockReturnValue([]),
    cleanupExpired: vi.fn(),
    listResumableJobs: vi.fn().mockReturnValue([job]),
    transitionJob: vi.fn().mockReturnValue(true),
    createAccessToken: vi.fn((kind: "download" | "share") => ({ token: `signed-${kind}-token` })),
    saveLocalResult: vi.fn(),
    saveTelegramMedia: vi.fn(),
    setActivePrivateImage: vi.fn(),
  };
  const client = {
    resolveAPIKey: vi.fn().mockResolvedValue("private-user-key"),
    pollImage: vi.fn().mockResolvedValue({
      status: "succeeded",
      progress: 100,
      resultUrl: "https://upstream.invalid/private-result",
      resultBase64: null,
    }),
    getContent: vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      filename: "mia-image.png",
    }),
  };
  const api = {
    sendPhoto,
    sendDocument: vi.fn(),
    sendVideo: vi.fn(),
    sendMessage: vi.fn(),
    deleteMessage: vi.fn().mockResolvedValue(true),
    editMessageText: vi.fn(),
    editMessageReplyMarkup: vi.fn(),
  };
  const worker = new MediaWorker({
    client: client as never,
    store: store as never,
    api: api as never,
    botToken: "telegram-token",
    logger: createLogger("silent"),
    intervalMs: 5_000,
    resultMaxBytes: 50_000_000,
    publicBaseUrl,
    botUsername: "MiaAssistantBot",
  });
  return { worker, store, sendPhoto };
}

describe("MediaWorker download buttons", () => {
  it("keeps original downloads in Telegram without exposing the upstream result", async () => {
    const { worker, store, sendPhoto } = createWorker("https://apimaster.ai");

    await worker.tick();

    const replyMarkup = sendPhoto.mock.calls[0]?.[2]?.reply_markup;
    expect(replyMarkup.inline_keyboard[1]).toEqual([
      { text: "Download original", callback_data: "media:7:download" },
      {
        text: "Share on X",
        url: "https://x.com/intent/post?text=I+just+created+this+image+with+Mia.&url=https%3A%2F%2Fapimaster.ai%2Fmia%2Fshare%2Fsigned-share-token",
      },
    ]);
    expect(JSON.stringify(replyMarkup)).not.toContain("upstream.invalid");
    expect(store.createAccessToken).toHaveBeenCalledWith("share", job.id);
    expect(store.createAccessToken).not.toHaveBeenCalledWith("download", job.id);
    expect(store.saveLocalResult).toHaveBeenCalledWith(job.id, new Uint8Array([1, 2, 3]));
  });

  it("uses the same Telegram callback when no public Mia URL is configured", async () => {
    const { worker, store, sendPhoto } = createWorker(null);

    await worker.tick();

    const replyMarkup = sendPhoto.mock.calls[0]?.[2]?.reply_markup;
    expect(replyMarkup.inline_keyboard[1]).toEqual([{
      text: "Download original",
      callback_data: "media:7:download",
    }]);
    expect(store.createAccessToken).not.toHaveBeenCalled();
  });
});
