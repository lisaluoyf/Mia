import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { DebugService } from "./service.js";

const userQuery = z.object({ telegram_user_id: z.coerce.number().int().positive() });
const requestParams = z.object({ id: z.string().uuid() });

function matches(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function registerDebugRoutes(app: FastifyInstance, options: { serviceKey: string; service: DebugService }): void {
  app.addHook("preHandler", (request, reply, done) => {
    if (!matches(request.headers["x-mia-internal-key"], options.serviceKey)) {
      void reply.code(404).send({ error: "not_found" });
      return;
    }
    done();
  });

  const userId = (request: FastifyRequest, reply: FastifyReply): number | null => {
    const parsed = userQuery.safeParse(request.query);
    if (!parsed.success) {
      void reply.code(400).send({ error: "invalid_request" });
      return null;
    }
    return parsed.data.telegram_user_id;
  };

  app.get("/internal/debug/requests", (request, reply) => {
    const id = userId(request, reply);
    if (id === null) return;
    return { success: true, data: options.service.requests(id) };
  });
  app.get("/internal/debug/requests/:id", (request, reply) => {
    const telegramUserId = userId(request, reply);
    const parsed = requestParams.safeParse(request.params);
    if (telegramUserId === null || !parsed.success) return reply.code(404).send({ error: "not_found" });
    const item = options.service.request(telegramUserId, parsed.data.id);
    return item ? { success: true, data: item } : reply.code(404).send({ error: "not_found" });
  });
  app.get("/internal/debug/memory", (request, reply) => {
    const id = userId(request, reply);
    if (id === null) return;
    return { success: true, data: options.service.memory(id) };
  });
  app.get("/internal/debug/prompts", (request, reply) => {
    const id = userId(request, reply);
    if (id === null) return;
    return { success: true, data: options.service.prompts() };
  });
  app.delete("/internal/debug/requests", (request, reply) => {
    const id = userId(request, reply);
    if (id === null) return;
    return { success: true, data: options.service.clear(id) };
  });
}

