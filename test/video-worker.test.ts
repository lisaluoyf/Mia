import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";

import { MediaAPIError, type APIMasterClient } from "../src/clients/apimaster.js";
import { createLogger } from "../src/logger.js";
import { MediaStore } from "../src/media/store.js";
import { MediaWorker } from "../src/media/worker.js";

describe("video submission resolution intent", () => {
  let store: MediaStore;

  afterEach(() => store?.close());

  function setup(options: Record<string, unknown>) {
    store = new MediaStore(":memory:");
    const draft = store.createDraft({
      telegramUserId: 42, chatId: 42, threadId: null,
      type: "video_generate", idempotencyKey: "video-resolution", requestMessageId: 77,
      model: "MiniMax-H3", instruction: "A paper boat on a lake",
      options: { durationSeconds: 15, aspectRatio: "16:9", locale: "zh-CN", ...options },
    });
    store.updateDraft(draft.id, draft.options, 78);
    store.claimDraft(draft.id);
    const client = {
      resolveAPIKey: vi.fn().mockResolvedValue("test-key"),
      submitVideo: vi.fn().mockResolvedValue("video-task"),
    };
    const editMessageText = vi.fn().mockResolvedValue({});
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 79 });
    const worker = new MediaWorker({
      client: client as unknown as APIMasterClient, store,
      api: { editMessageText, sendMessage } as unknown as Api,
      botToken: "123:test", logger: createLogger("silent"), intervalMs: 1_000,
      resultMaxBytes: 10_000_000, publicBaseUrl: null, botUsername: "MiaAssistantBot",
    });
    return { worker, client, sendMessage, id: draft.id };
  }

  it.each([
    { resolutionSource: "channel_default" },
    { resolutionSource: "channel_default", resolution: "720p" },
  ])("does not pin a resolution for channel_default: %j", async (options) => {
    const { worker, client, id } = setup(options);
    await worker.tick();
    expect(client.submitVideo).toHaveBeenCalledOnce();
    const input = client.submitVideo.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input).not.toHaveProperty("resolution");
    expect(input).toMatchObject({ durationSeconds: 15, aspectRatio: "16:9" });
    expect(store.getJob(id)).toMatchObject({ status: "submitted", upstreamTaskId: "video-task" });
  });

  it("preserves an explicit user resolution", async () => {
    const { worker, client } = setup({ resolutionSource: "user", resolution: "2K" });
    await worker.tick();
    expect(client.submitVideo).toHaveBeenCalledWith("test-key", expect.objectContaining({ resolution: "2K" }));
  });

  it.each([
    { resolution: "720p" },
    { resolution: "2K" },
    { resolutionSource: "user", resolution: "" },
  ])("requires reconfirmation instead of guessing old or invalid intent: %j", async (options) => {
    const { worker, client, sendMessage, id } = setup(options);
    await worker.tick();
    expect(client.submitVideo).not.toHaveBeenCalled();
    expect(store.getJob(id)).toMatchObject({ status: "failed", errorCode: "video_resolution_confirmation_required" });
    expect(sendMessage).toHaveBeenCalledWith(42, expect.stringContaining("分辨率需要重新确认"), expect.anything());
  });

  it("does not claim an automatic retry when a video submission fails", async () => {
    const { worker, client, sendMessage } = setup({ resolutionSource: "channel_default" });
    client.submitVideo.mockRejectedValue(new MediaAPIError("upstream_error", 400));
    await worker.tick();
    expect(client.submitVideo).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(42, "视频请求提交失败。", expect.anything());
  });
});
