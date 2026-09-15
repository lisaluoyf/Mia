import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger } from "../src/logger.js";

describe("logger redaction", () => {
  it("does not emit bot tokens, service secrets, or API keys", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk: unknown, _encoding, callback) {
        output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        callback();
      },
    });
    const logger = createLogger("info", destination);

    logger.info({
      telegramBotToken: "secret-bot-token",
      serviceKey: "secret-service-key",
      apiKey: "secret-api-key",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(output).not.toContain("secret-bot-token");
    expect(output).not.toContain("secret-service-key");
    expect(output).not.toContain("secret-api-key");
  });

  it("redacts Telegram tokens nested in Grammy errors", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk: unknown, _encoding, callback) {
        output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        callback();
      },
    });
    const logger = createLogger("info", destination);
    const error = Object.assign(new Error("Telegram update failed"), {
      ctx: { api: { token: "123456:secret-telegram-token" } },
    });

    logger.error({ err: error }, "Unhandled Telegram update error");
    await new Promise((resolve) => setImmediate(resolve));

    expect(output).not.toContain("123456:secret-telegram-token");
    expect(output).toContain("[REDACTED]");
  });

  it("redacts expiring media access tokens from request URLs", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk: unknown, _encoding, callback) {
        output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        callback();
      },
    });
    const logger = createLogger("info", destination);
    logger.info({ req: { method: "GET", url: "/media/download/private-token-value" } });
    logger.info({ req: { method: "GET", url: "/mia/share/private-share-token?utm_source=x" } });
    logger.info({ req: { method: "GET", url: "/mia/media/share/private-image-token" } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(output).not.toContain("private-token-value");
    expect(output).not.toContain("private-share-token");
    expect(output).not.toContain("private-image-token");
    expect(output).toContain("/media/download/[REDACTED]");
    expect(output).toContain("/mia/share/[REDACTED]?utm_source=x");
    expect(output).toContain("/mia/media/share/[REDACTED]");
  });
});
