import { z } from "zod";

import { MIA_SYSTEM_PROMPT } from "../prompts.js";
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

const structuredChatResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.union([z.string(), z.record(z.string(), z.unknown())]) }),
  })).min(1),
});

const imageSubmitResponseSchema = z.object({
  data: z.array(z.object({ task_id: z.string().min(1), status: z.string().optional() })).min(1),
});

const imagePollResponseSchema = z.object({
  data: z.object({
    status: z.string(),
    progress: z.union([z.string(), z.number()]).optional(),
    result: z.object({
      images: z.array(z.object({
        url: z.string().optional(),
        b64_json: z.string().optional(),
      })),
    }).optional(),
    error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
  }),
});

const videoTaskResponseSchema = z.object({
  id: z.string().optional(),
  task_id: z.string().optional(),
  status: z.string(),
  progress: z.number().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).nullable().optional(),
}).refine((value) => Boolean(value.id ?? value.task_id));

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
      video_capabilities: z.object({
        modes: z.array(z.enum(["text_to_video", "image_to_video"])),
        duration_seconds: z.object({ min: z.number().int(), max: z.number().int(), default: z.number().int() }),
        resolutions: z.array(z.string()),
        default_resolution: z.string(),
        aspect_ratios: z.array(z.string()),
        default_aspect_ratio: z.string(),
        max_reference_images: z.number().int().nonnegative(),
      }).optional(),
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

export class MediaAPIError extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number,
  ) {
    super(`APIMaster media request failed: ${code}`);
    this.name = "MediaAPIError";
  }
}

export interface StructuredMessage {
  role: "system" | "user" | "assistant";
  content: unknown;
}

export interface MediaBinary {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}

export interface NormalizedTaskStatus {
  status: "queued" | "in_progress" | "succeeded" | "failed";
  progress: number | null;
  resultUrl: string | null;
  resultBase64: string | null;
  errorCode: string | null;
}

export interface VideoSubmitInput {
  model: string;
  prompt: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  images?: readonly { dataUrl: string; role: "first_frame" | "last_frame" | "reference_image" }[];
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
        videoCapabilities: model.video_capabilities === undefined ? undefined : {
          modes: model.video_capabilities.modes,
          durationSeconds: model.video_capabilities.duration_seconds,
          resolutions: model.video_capabilities.resolutions,
          defaultResolution: model.video_capabilities.default_resolution,
          aspectRatios: model.video_capabilities.aspect_ratios,
          defaultAspectRatio: model.video_capabilities.default_aspect_ratio,
          maxReferenceImages: model.video_capabilities.max_reference_images,
        },
      })),
    };
  }

  async chat(apiKey: string, model: string, userMessage: string): Promise<string> {
    return this.chatMessages(apiKey, model, [
      { role: "system", content: MIA_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ]);
  }

  async chatMessages(apiKey: string, model: string, messages: readonly StructuredMessage[]): Promise<string> {
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
          messages,
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
    if (!parsed.success || parsed.data.choices[0] === undefined) throw new ChatCompletionError(response.status);
    return parsed.data.choices[0].message.content;
  }

  async structuredChat(
    apiKey: string,
    model: string,
    messages: readonly StructuredMessage[],
    schemaName: string,
    schema: object,
    timeoutMs = this.options.timeoutMs,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          temperature: 0,
          response_format: {
            type: "json_schema",
            json_schema: { name: schemaName, strict: true, schema },
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ChatCompletionError();
    }
    if (!response.ok) {
      throw new ChatCompletionError(response.status);
    }
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = structuredChatResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ChatCompletionError(response.status);
    }
    const content = parsed.data.choices[0]?.message.content;
    if (typeof content === "string") {
      try {
        return JSON.parse(content) as unknown;
      } catch {
        throw new ChatCompletionError(response.status);
      }
    }
    return content;
  }

  async vision(
    apiKey: string,
    model: string,
    instruction: string,
    images: readonly MediaBinary[],
    context: readonly StructuredMessage[] = [],
  ): Promise<string> {
    const content = [
      { type: "text", text: instruction },
      ...images.map((image) => ({
        type: "image_url",
        image_url: { url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}` },
      })),
    ];
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: MIA_SYSTEM_PROMPT },
            ...context,
            { role: "user", content },
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
    if (!parsed.success || parsed.data.choices[0] === undefined) {
      throw new ChatCompletionError(response.status);
    }
    return parsed.data.choices[0].message.content;
  }

  async submitImage(
    apiKey: string,
    model: string,
    prompt: string,
    aspectRatio: "1:1" | "16:9" | "9:16",
    images: readonly MediaBinary[] = [],
  ): Promise<string> {
    let body: BodyInit;
    let headers: HeadersInit;
    if (images.length === 0) {
      headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
      body = JSON.stringify({ model, prompt, n: 1, size: aspectRatio, resolution: "1K" });
    } else {
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", prompt);
      form.set("n", "1");
      form.set("size", aspectRatio);
      form.set("resolution", "1K");
      for (const image of images) {
        form.append("images", new Blob([Buffer.from(image.bytes)], { type: image.mimeType }), image.filename);
      }
      headers = { authorization: `Bearer ${apiKey}` };
      body = form;
    }
    const response = await this.mediaFetch("/v1/images/generations/async", apiKey, { method: "POST", headers, body });
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = imageSubmitResponseSchema.safeParse(payload);
    const taskId = parsed.success ? parsed.data.data[0]?.task_id : undefined;
    if (taskId === undefined) {
      throw new MediaAPIError("invalid_submit_response", response.status);
    }
    return taskId;
  }

  async pollImage(apiKey: string, model: string, taskId: string): Promise<NormalizedTaskStatus> {
    const response = await this.mediaFetch(`/v1/tasks/${encodeURIComponent(taskId)}?model=${encodeURIComponent(model)}`, apiKey);
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = imagePollResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new MediaAPIError("invalid_poll_response", response.status);
    }
    const data = parsed.data.data;
    const status = normalizeTaskStatus(data.status);
    const first = data.result?.images[0];
    return {
      status,
      progress: normalizeProgress(data.progress, status),
      resultUrl: first?.url ?? null,
      resultBase64: first?.b64_json ?? null,
      errorCode: data.error?.code ?? (status === "failed" ? "image_generation_failed" : null),
    };
  }

  async submitVideo(apiKey: string, input: VideoSubmitInput): Promise<string> {
    const content = [
      { type: "text", text: input.prompt },
      ...(input.images ?? []).map((image) => ({
        type: "image_url",
        role: image.role,
        image_url: { url: image.dataUrl },
      })),
    ];
    const response = await this.mediaFetch("/v1/videos", apiKey, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        duration: input.durationSeconds,
        size: input.resolution,
        metadata: {
          content,
          duration: input.durationSeconds,
          resolution: input.resolution,
          ratio: input.aspectRatio,
        },
      }),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = videoTaskResponseSchema.safeParse(payload);
    const taskId = parsed.success ? parsed.data.id ?? parsed.data.task_id : undefined;
    if (taskId === undefined) {
      throw new MediaAPIError("invalid_submit_response", response.status);
    }
    return taskId;
  }

  async pollVideo(apiKey: string, taskId: string): Promise<NormalizedTaskStatus> {
    const response = await this.mediaFetch(`/v1/videos/${encodeURIComponent(taskId)}`, apiKey);
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = videoTaskResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new MediaAPIError("invalid_poll_response", response.status);
    }
    const status = normalizeTaskStatus(parsed.data.status);
    return {
      status,
      progress: parsed.data.progress ?? normalizeProgress(undefined, status),
      resultUrl: status === "succeeded" ? `${this.options.baseUrl}/v1/videos/${encodeURIComponent(taskId)}/content` : null,
      resultBase64: null,
      errorCode: parsed.data.error?.code ?? (status === "failed" ? "video_generation_failed" : null),
    };
  }

  async getContent(apiKey: string, pathOrUrl: string, maxBytes: number): Promise<MediaBinary> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.options.baseUrl}${pathOrUrl}`;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...(this.isAPIMasterUrl(url) ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      throw new MediaAPIError("content_unavailable");
    }
    if (!response.ok) {
      throw new MediaAPIError("content_unavailable", response.status);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > maxBytes) {
      throw new MediaAPIError("content_too_large", 413);
    }
    if (!response.body) throw new MediaAPIError("content_unavailable", response.status);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MediaAPIError("content_too_large", 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total));
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0] ?? "application/octet-stream";
    return { bytes, mimeType, filename: mimeType.startsWith("video/") ? "mia-video.mp4" : "mia-image.png" };
  }

  async streamContent(apiKey: string, pathOrUrl: string): Promise<Response> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.options.baseUrl}${pathOrUrl}`;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...(this.isAPIMasterUrl(url) ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      throw new MediaAPIError("content_unavailable");
    }
    if (!response.ok || !response.body) {
      throw new MediaAPIError("content_unavailable", response.status);
    }
    return response;
  }

  private async mediaFetch(path: string, apiKey: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.baseUrl}${path}`, {
        ...init,
        headers: init.headers ?? { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      throw new MediaAPIError("service_unavailable");
    }
    if (!response.ok) {
      throw new MediaAPIError(response.status === 402 ? "insufficient_quota" : "upstream_error", response.status);
    }
    return response;
  }

  private isAPIMasterUrl(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.options.baseUrl).origin;
    } catch {
      return false;
    }
  }
}

function normalizeTaskStatus(status: string): NormalizedTaskStatus["status"] {
  switch (status.toLowerCase()) {
    case "success":
    case "succeeded":
    case "completed":
      return "succeeded";
    case "failed":
    case "error":
    case "cancelled":
    case "canceled":
      return "failed";
    case "queued":
    case "submitted":
      return "queued";
    default:
      return "in_progress";
  }
}

function normalizeProgress(value: string | number | undefined, status: NormalizedTaskStatus["status"]): number | null {
  if (status === "succeeded" || status === "failed") {
    return 100;
  }
  const parsed = typeof value === "number" ? value : Number.parseInt(value?.replace("%", "") ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null;
}
