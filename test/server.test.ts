import type { Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";

const serviceKey = "test-internal-service-key";

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

  it("streams signed media downloads through the public Mia route", async () => {
    const store = {
      getAccessToken: vi.fn().mockReturnValue({ jobId: 7 }),
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
