import { timingSafeEqual } from "node:crypto";

import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { Update } from "grammy/types";
import type { Logger } from "pino";
import { z } from "zod";

import { registerMiniAppRoutes } from "./mini-app/routes.js";
import type { ModelSettingsService } from "./settings/service.js";

const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
}).passthrough();

interface ServerOptions {
  logger: Logger;
  serviceKey: string;
  handleUpdate: (update: Update) => Promise<void>;
  miniApp?: {
    botToken: string;
    maxAuthAgeSeconds: number;
    settings: ModelSettingsService;
    staticRoot?: string;
  };
}

function authenticated(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== "string") {
    return false;
  }
  const actualBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createServer({ logger, serviceKey, handleUpdate, miniApp }: ServerOptions) {
  const app = Fastify({ loggerInstance: logger, bodyLimit: 1024 * 1024, trustProxy: true });

  app.addHook("onRequest", (request, reply, done) => {
    if (request.url === "/mia" || request.url.startsWith("/mia/")) {
      reply.header("content-security-policy", "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org");
      reply.header("referrer-policy", "no-referrer");
      reply.header("x-content-type-options", "nosniff");
      reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    }
    done();
  });

  void app.register(rateLimit, { global: false });
  if (miniApp) {
    void app.register((instance, _options, done) => {
      registerMiniAppRoutes(instance, miniApp);
      done();
    });
    if (miniApp.staticRoot) {
      void app.register(fastifyStatic, {
        root: miniApp.staticRoot,
        prefix: "/mia/",
        decorateReply: true,
      });
      app.get("/mia", (_request, reply) => reply.redirect("/mia/"));
    }
  }

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
