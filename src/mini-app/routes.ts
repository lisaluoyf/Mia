import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { ResolverError } from "../clients/apimaster.js";
import { InvalidModelPreferenceError, type ModelSettingsService } from "../settings/service.js";
import { MiniAppAuthError, type TelegramMiniAppUser, verifyTelegramInitData } from "./auth.js";

const settingsSchema = z.object({
  chatModel: z.string().trim().min(1).nullable(),
  imageModel: z.string().trim().min(1).nullable(),
  videoModel: z.string().trim().min(1).nullable(),
});

interface MiniAppRoutesOptions {
  botToken: string;
  maxAuthAgeSeconds: number;
  settings: ModelSettingsService;
}

function authenticate(request: FastifyRequest, options: MiniAppRoutesOptions): TelegramMiniAppUser {
  const raw = request.headers["x-telegram-init-data"];
  return verifyTelegramInitData(
    typeof raw === "string" ? raw : undefined,
    options.botToken,
    options.maxAuthAgeSeconds,
  );
}

function publicUser(user: TelegramMiniAppUser) {
  return {
    id: user.id,
    firstName: user.first_name,
    lastName: user.last_name ?? null,
    username: user.username ?? null,
    languageCode: user.language_code ?? null,
    photoUrl: user.photo_url ?? null,
  };
}

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof MiniAppAuthError) {
    return reply.code(401).send({ success: false, code: `telegram_auth_${error.code}` });
  }
  if (error instanceof ResolverError) {
    const status = error.code === "user_disabled" ? 403 : error.code === "service_unavailable" ? 503 : 404;
    return reply.code(status).send({ success: false, code: error.code });
  }
  if (error instanceof InvalidModelPreferenceError) {
    return reply.code(422).send({ success: false, code: "invalid_model", field: error.capability });
  }
  throw error;
}

export function registerMiniAppRoutes(app: FastifyInstance, options: MiniAppRoutesOptions) {
  const rateLimit = { max: 60, timeWindow: "1 minute" };

  app.get("/mia/api/bootstrap", { config: { rateLimit } }, async (request, reply) => {
    try {
      const user = authenticate(request, options);
      const snapshot = await options.settings.getSnapshot(user.id);
      return { success: true, data: { user: publicUser(user), ...snapshot } };
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.get("/mia/api/settings", { config: { rateLimit } }, (request, reply) => {
    try {
      const user = authenticate(request, options);
      return { success: true, data: options.settings.getPreferences(user.id) };
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.put("/mia/api/settings", {
    bodyLimit: 16 * 1024,
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    try {
      const user = authenticate(request, options);
      const parsed = settingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, code: "invalid_request" });
      }
      const settings = await options.settings.save(user.id, parsed.data);
      return { success: true, data: settings };
    } catch (error) {
      return sendError(error, reply);
    }
  });
}
