import type { Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentStore } from "../src/agent/store.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";

const serviceKey = "test-internal-service-key";
const telegramWebhookSecret = "test-telegram-webhook-secret-123456";

describe("Mia server", () => {
  it("reports readiness", async () => {
    const app = createServer({
      logger: createLogger("silent"),
      serviceKey,
      handleUpdate: vi.fn(),
    });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("rejects updates without internal authentication", async () => {
    const handleUpdate = vi.fn<(update: Update) => Promise<void>>();
    const app = createServer({ logger: createLogger("silent"), serviceKey, handleUpdate });
    const response = await app.inject({
      method: "POST",
      url: "/telegram/update",
      payload: { update_id: 100 },
    });
    expect(response.statusCode).toBe(401);
    expect(handleUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts authenticated Telegram updates for background processing", async () => {
    let resolveHandled: (() => void) | undefined;
    const handled = new Promise<void>((resolve) => {
      resolveHandled = resolve;
    });
    const handleUpdate = vi.fn<(update: Update) => Promise<void>>().mockImplementation(() => {
      resolveHandled?.();
      return Promise.resolve();
    });
    const app = createServer({ logger: createLogger("silent"), serviceKey, handleUpdate });
    const update = {
      update_id: 101,
      message: {
        message_id: 5,
        date: 1_787_000_000,
        chat: { id: 123, type: "private" },
        from: { id: 123, is_bot: false, first_name: "Test" },
        text: "hi",
      },
    } satisfies Update;
    const response = await app.inject({
      method: "POST",
      url: "/telegram/update",
      headers: { "x-mia-internal-key": serviceKey },
      payload: update,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
    await handled;
    expect(handleUpdate).toHaveBeenCalledWith(update);
    await app.close();
  });

  it("accepts only Telegram-authenticated updates on the public webhook", async () => {
    const handleUpdate = vi.fn<(update: Update) => Promise<void>>().mockResolvedValue();
    const app = createServer({
      logger: createLogger("silent"),
      serviceKey,
      telegramWebhookSecret,
      handleUpdate,
    });
    const update = { update_id: 102 } satisfies Update;

    const missing = await app.inject({ method: "POST", url: "/telegram/webhook", payload: update });
    const wrong = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "wrong-secret" },
      payload: update,
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": telegramWebhookSecret },
      payload: update,
    });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(202);
    await vi.waitFor(() => expect(handleUpdate).toHaveBeenCalledWith(update));
    await app.close();
  });

  it("rejects malformed public webhook updates before enqueueing", async () => {
    const enqueueUpdate = vi.fn().mockReturnValue(true);
    const app = createServer({
      logger: createLogger("silent"),
      serviceKey,
      telegramWebhookSecret,
      handleUpdate: vi.fn(),
      enqueueUpdate,
    });
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": telegramWebhookSecret },
      payload: { message: { text: "missing update id" } },
    });

    expect(response.statusCode).toBe(400);
    expect(enqueueUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it("durably deduplicates repeated public webhook updates", async () => {
    const store = new AgentStore(":memory:");
    const app = createServer({
      logger: createLogger("silent"),
      serviceKey,
      telegramWebhookSecret,
      handleUpdate: vi.fn(),
      enqueueUpdate: (update) => {
        store.enqueueUpdate(update);
        return true;
      },
    });
    const request = {
      method: "POST" as const,
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": telegramWebhookSecret },
      payload: { update_id: 103 },
    };

    expect((await app.inject(request)).statusCode).toBe(202);
    expect((await app.inject(request)).statusCode).toBe(202);
    expect(store.updates()).toEqual([{ update_id: 103 }]);
    store.close();
    await app.close();
  });

  it("does not acknowledge a public webhook when durable enqueue fails", async () => {
    const handleUpdate = vi.fn();
    const app = createServer({
      logger: createLogger("silent"),
      serviceKey,
      telegramWebhookSecret,
      handleUpdate,
      enqueueUpdate: () => { throw new Error("disk unavailable"); },
    });
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": telegramWebhookSecret },
      payload: { update_id: 104 },
    });

    expect(response.statusCode).toBe(500);
    expect(handleUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it("streams signed media downloads through the public Mia route", async () => {
    const store = {
      getAccessToken: vi.fn().mockReturnValue({ jobId: 7 }),
      getLocalResult: vi.fn().mockReturnValue(null),
      getJob: vi.fn().mockReturnValue({
        status: "succeeded",
        resultUrl: "https://upstream.invalid/private-result",
        telegramUserId: 123,
        model: "image-model",
        type: "image_generate",
      }),
    };
    const client = {
      resolveAPIKey: vi.fn().mockResolvedValue("private-user-key"),
      streamContent: vi.fn().mockResolvedValue(new Response("image-bytes", {
        headers: { "content-type": "image/png", "content-length": "11" },
      })),
    };
    const app = createServer({
      logger: createLogger("silent"),
      serviceKey,
      handleUpdate: vi.fn(),
      mediaDownload: { store, client } as never,
    });

    const response = await app.inject({ method: "GET", url: "/mia/media/download/signed-token" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("image-bytes");
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="mia-image.png"');
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(store.getAccessToken).toHaveBeenCalledWith("signed-token", "download");
    expect(client.streamContent).toHaveBeenCalledWith("private-user-key", "https://upstream.invalid/private-result");
    await app.close();
  });

  it("downloads a locally stored Base64 result without requiring an upstream URL", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mia-server-result-"));
    const path = join(directory, "7");
    writeFileSync(path, "base64-image");
    const client = {
      resolveAPIKey: vi.fn(),
      streamContent: vi.fn(),
    };
    const app = createServer({
      logger: createLogger("silent"),
      serviceKey,
      handleUpdate: vi.fn(),
      mediaDownload: {
        store: {
          getAccessToken: vi.fn().mockReturnValue({ jobId: 7 }),
          getJob: vi.fn().mockReturnValue({
            id: 7,
            status: "succeeded",
            resultUrl: null,
            resultMimeType: "image/png",
            type: "image_generate",
          }),
          getLocalResult: vi.fn().mockReturnValue({
            path,
            size: 12,
            mimeType: "image/png",
            filename: "mia-image.png",
          }),
        },
        client,
      } as never,
    });

    try {
      const response = await app.inject({ method: "GET", url: "/mia/media/download/signed-token" });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("base64-image");
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.headers["content-disposition"]).toBe('attachment; filename="mia-image.png"');
      expect(client.resolveAPIKey).not.toHaveBeenCalled();
      expect(client.streamContent).not.toHaveBeenCalled();
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serves an expiring image share page with X card metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mia-share-result-"));
    const path = join(directory, "7");
    writeFileSync(path, "shared-image");
    const store = {
      getAccessToken: vi.fn().mockReturnValue({ jobId: 7 }),
      getJob: vi.fn().mockReturnValue({
        id: 7,
        status: "succeeded",
        type: "image_generate",
        resultMimeType: "image/png",
      }),
      getLocalResult: vi.fn().mockReturnValue({
        path,
        size: 12,
        mimeType: "image/png",
        filename: "mia-image.png",
      }),
    };
    const app = createServer({
      logger: createLogger("silent"),
      serviceKey,
      handleUpdate: vi.fn(),
      mediaDownload: { store, client: {}, publicBaseUrl: "https://apimaster.ai" } as never,
    });

    try {
      const page = await app.inject({ method: "GET", url: "/mia/share/share-token" });
      expect(page.statusCode).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.body).toContain('content="summary_large_image"');
      expect(page.body).toContain('content="https://apimaster.ai/mia/media/share/share-token"');
      expect(store.getAccessToken).toHaveBeenCalledWith("share-token", "share");

      const image = await app.inject({ method: "GET", url: "/mia/media/share/share-token" });
      expect(image.statusCode).toBe(200);
      expect(image.body).toBe("shared-image");
      expect(image.headers["content-type"]).toBe("image/png");
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid media download tokens", async () => {
    const app = createServer({
      logger: createLogger("silent"),
      serviceKey,
      handleUpdate: vi.fn(),
      mediaDownload: {
        store: { getAccessToken: vi.fn().mockReturnValue(null) },
        client: {},
      } as never,
    });

    const response = await app.inject({ method: "GET", url: "/mia/media/download/expired-token" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "download_not_found" });
    await app.close();
  });

  it("returns 502 when the upstream media cannot be streamed", async () => {
    const app = createServer({
      logger: createLogger("silent"),
      serviceKey,
      handleUpdate: vi.fn(),
      mediaDownload: {
        store: {
          getAccessToken: vi.fn().mockReturnValue({ jobId: 7 }),
          getLocalResult: vi.fn().mockReturnValue(null),
          getJob: vi.fn().mockReturnValue({
            status: "succeeded",
            resultUrl: "https://upstream.invalid/private-result",
            telegramUserId: 123,
            model: "image-model",
            type: "image_generate",
          }),
        },
        client: {
          resolveAPIKey: vi.fn().mockResolvedValue("private-user-key"),
          streamContent: vi.fn().mockRejectedValue(new Error("upstream unavailable")),
        },
      } as never,
    });

    const response = await app.inject({ method: "GET", url: "/mia/media/download/signed-token" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "download_unavailable" });
    await app.close();
  });
});
