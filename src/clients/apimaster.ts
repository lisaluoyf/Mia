import { z } from "zod";

import { SYSTEM_PROMPT } from "../constants.js";
import type { ModelOption } from "../settings/types.js";

type Fetcher = typeof fetch;

const resolveResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    user_id: z.number().int().positive(),
    token_id: z.number().int().positive(),
    api_key: z.string().min(1),
  }),
});

const errorResponseSchema = z.object({
  code: z.string().optional(),
});

const chatResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string().min(1),
      }),
    }),
  ).min(1),
});

const modelCatalogResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    user_id: z.number().int().positive(),
    models: z.array(z.object({
      id: z.string().min(1),
      display_name: z.string().min(1),
      vendor: z.string(),
      capability: z.enum(["chat", "image", "video"]),
      recommended: z.boolean(),
      supports_vision: z.boolean().optional().default(false),
      vision_recommended: z.boolean().optional().default(false),
      supported_endpoint_types: z.array(z.string()),
    })),
  }),
});

export interface ModelCatalog {
  apimasterUserId: number;
  models: ModelOption[];
}

export type ResolverErrorCode =
  | "telegram_not_bound"
  | "user_disabled"
  | "no_usable_api_key"
  | "service_unavailable";

export class ResolverError extends Error {
  constructor(
    public readonly code: ResolverErrorCode,
    public readonly status?: number,
  ) {
    super(`APIMaster key resolution failed: ${code}`);
    this.name = "ResolverError";
  }
}

export class ChatCompletionError extends Error {
  constructor(public readonly status?: number) {
    super("APIMaster chat completion failed");
    this.name = "ChatCompletionError";
  }
}

interface ClientOptions {
  baseUrl: string;
  internalBaseUrl: string;
  serviceKey: string;
  timeoutMs: number;
  fetcher?: Fetcher;
}

export class APIMasterClient {
  private readonly fetcher: Fetcher;

  constructor(private readonly options: ClientOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async resolveAPIKey(telegramUserId: number, model: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.options.internalBaseUrl}/api/user/internal/telegram-api-key`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-mia-internal-key": this.options.serviceKey,
          },
          body: JSON.stringify({
            telegram_user_id: String(telegramUserId),
            model,
          }),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        },
      );
    } catch {
      throw new ResolverError("service_unavailable");
    }

    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined);
      const parsedError = errorResponseSchema.safeParse(payload);
      const code = parsedError.success ? parsedError.data.code : undefined;
      if (code === "telegram_not_bound" || code === "user_disabled" || code === "no_usable_api_key") {
        throw new ResolverError(code, response.status);
      }
      throw new ResolverError("service_unavailable", response.status);
    }

    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = resolveResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ResolverError("service_unavailable", response.status);
    }
    return parsed.data.data.api_key;
  }

  async listModels(telegramUserId: number): Promise<ModelCatalog> {
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.options.internalBaseUrl}/api/user/internal/mia-models`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-mia-internal-key": this.options.serviceKey,
          },
          body: JSON.stringify({ telegram_user_id: String(telegramUserId) }),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        },
      );
    } catch {
      throw new ResolverError("service_unavailable");
    }
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined);
      const parsedError = errorResponseSchema.safeParse(payload);
      const code = parsedError.success ? parsedError.data.code : undefined;
      if (code === "telegram_not_bound" || code === "user_disabled" || code === "no_usable_api_key") {
        throw new ResolverError(code, response.status);
      }
      throw new ResolverError("service_unavailable", response.status);
    }
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = modelCatalogResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ResolverError("service_unavailable", response.status);
    }
    return {
      apimasterUserId: parsed.data.data.user_id,
      models: parsed.data.data.models.map((model) => ({
        id: model.id,
        displayName: model.display_name,
        vendor: model.vendor,
        capability: model.capability,
        recommended: model.recommended,
        supportsVision: model.supports_vision,
        visionRecommended: model.vision_recommended,
      })),
    };
  }

  async chat(apiKey: string, model: string, userMessage: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
          stream: false,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      throw new ChatCompletionError();
    }

    if (!response.ok) {
      throw new ChatCompletionError(response.status);
    }

    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = chatResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ChatCompletionError(response.status);
    }
    const firstChoice = parsed.data.choices[0];
    if (firstChoice === undefined) {
      throw new ChatCompletionError(response.status);
    }
    return firstChoice.message.content;
  }
}
