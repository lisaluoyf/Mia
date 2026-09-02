import { timingSafeEqual } from "node:crypto";

import Fastify from "fastify";
import type { Update } from "grammy/types";
import type { Logger } from "pino";
import { z } from "zod";

const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
}).passthrough();

interface ServerOptions {
  logger: Logger;
  serviceKey: string;
  handleUpdate: (update: Update) => Promise<void>;
}

function authenticated(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== "string") {
    return false;
  }
  const actualBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createServer({ logger, serviceKey, handleUpdate }: ServerOptions) {
  const app = Fastify({ loggerInstance: logger, bodyLimit: 1024 * 1024 });

  app.get("/health", () => ({ status: "ok" }));
  app.post("/telegram/update", (request, reply) => {
    if (!authenticated(request.headers["x-mia-internal-key"], serviceKey)) {
      return reply.code(401).send({ accepted: false });
    }

    const parsed = telegramUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ accepted: false });
    }
    const update = parsed.data as Update;
    setImmediate(() => {
      void handleUpdate(update).catch((error: unknown) => {
        logger.error({ err: error, updateId: update.update_id }, "Telegram update processing failed");
      });
    });
    return reply.code(202).send({ accepted: true });
  });

  return app;
}
