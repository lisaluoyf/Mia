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

  it("redacts expiring media download tokens from request URLs", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk: unknown, _encoding, callback) {
        output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        callback();
      },
    });
    const logger = createLogger("info", destination);
    logger.info({ req: { method: "GET", url: "/media/download/private-token-value" } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(output).not.toContain("private-token-value");
    expect(output).toContain("/media/download/[REDACTED]");
  });
});
