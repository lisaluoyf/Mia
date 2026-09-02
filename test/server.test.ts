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
});
