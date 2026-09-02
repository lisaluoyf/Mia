import Fastify from "fastify";
import type { Logger } from "pino";

export function createHealthServer(logger: Logger) {
  const app = Fastify({ loggerInstance: logger });
  app.get("/health", () => ({ status: "ok" }));
  return app;
}
