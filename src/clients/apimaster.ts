import { z } from "zod";

import { promptText } from "../prompts.js";
import type { ModelOption } from "../settings/types.js";

type Fetcher = typeof fetch;
const IMAGE_EDIT_TIMEOUT_MS = 180_000;

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

const responsesResponseSchema = z.object({
  output_text: z.string().optional(),
  output: z.array(z.object({
    type: z.string(),
    action: z.object({
      type: z.string().optional(),
      query: z.string().optional(),
    }).passthrough().optional(),
    content: z.array(z.object({
      type: z.string(),
      text: z.string().optional(),
      annotations: z.array(z.object({
        type: z.string(),
        url: z.string().optional(),
        title: z.string().optional(),
        url_citation: z.object({
          url: z.string().optional(),
          title: z.string().optional(),
        }).passthrough().optional(),
      }).passthrough()).optional(),
    }).passthrough()).optional(),
  }).passthrough()).default([]),
});

const imageSubmitResponseSchema = z.object({
  data: z.array(z.object({ task_id: z.string().min(1), status: z.string().optional() })).min(1),
});

const imageEditResponseSchema = z.object({
  data: z.array(z.object({
    url: z.string().min(1).optional(),
    b64_json: z.string().min(1).optional(),
  }).refine((value) => Boolean(value.url ?? value.b64_json))).min(1),
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
      pricing: z.object({
        unit: z.enum(["token_1m", "image", "second"]),
        input_price: z.number().optional(),
        output_price: z.number().optional(),
        price: z.number().optional(),
        currency: z.string().default("USD"),
        discount_ratio: z.number().optional(),
        channel_name: z.string().optional(),
      }).optional(),
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

const debugIdentitiesResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    identities: z.array(z.object({
      email: z.string().email(),
      telegram_user_id: z.string().regex(/^\d+$/),
    })),
  }),
});

const telegramDeepLinkLoginResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ login_url: z.string().url() }),
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

export interface WebSearchUsage {
  callCount: number;
  queries: string[];
  sources: Array<{ title: string | null; url: string }>;
}

export interface StructuredResponseResult {
  data: unknown;
  webSearch: WebSearchUsage;
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

export type ImageSubmitResult =
  | { kind: "task"; taskId: string }
  | { kind: "result"; state: NormalizedTaskStatus };

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

  async confirmTelegramDeepLinkLogin(input: {
    code: string;
    telegramUserId: number;
    firstName: string;
    lastName?: string | null;
    username?: string | null;
    languageCode?: string | null;
  }): Promise<string | null> {
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.options.baseUrl}/api/auth/telegram/deep-link/confirm`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-mia-internal-key": this.options.serviceKey,
          },
          body: JSON.stringify({
            code: input.code,
            telegram_user_id: String(input.telegramUserId),
            first_name: input.firstName,
            last_name: input.lastName ?? null,
            username: input.username ?? null,
            language_code: input.languageCode ?? null,
          }),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        },
      );
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = telegramDeepLinkLoginResponseSchema.safeParse(payload);
    return parsed.success ? parsed.data.data.login_url : null;
  }

  async resolveDebugTelegramUsers(emails: readonly string[]): Promise<number[]> {
    if (emails.length === 0) return [];
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.options.internalBaseUrl}/api/user/internal/mia-debug-identities`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-mia-internal-key": this.options.serviceKey,
          },
          body: JSON.stringify({ emails }),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        },
      );
    } catch {
      throw new ResolverError("service_unavailable");
    }
    if (!response.ok) throw new ResolverError("service_unavailable", response.status);
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = debugIdentitiesResponseSchema.safeParse(payload);
    if (!parsed.success) throw new ResolverError("service_unavailable", response.status);
    return parsed.data.data.identities.map((identity) => Number(identity.telegram_user_id));
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
        ...(model.pricing === undefined ? {} : { pricing: {
          unit: model.pricing.unit,
          ...(model.pricing.input_price === undefined ? {} : { inputPrice: model.pricing.input_price }),
          ...(model.pricing.output_price === undefined ? {} : { outputPrice: model.pricing.output_price }),
          ...(model.pricing.price === undefined ? {} : { price: model.pricing.price }),
          currency: model.pricing.currency,
          ...(model.pricing.discount_ratio === undefined ? {} : { discountRatio: model.pricing.discount_ratio }),
          ...(model.pricing.channel_name === undefined ? {} : { channelName: model.pricing.channel_name }),
        } }),
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

  async chat(apiKey: string, model: string, userMessage: string, locale?: string | null): Promise<string> {
    return this.chatMessages(apiKey, model, [
      { role: "system", content: promptText("mia.system", locale) },
      { role: "user", content: userMessage },
    ]);
  }

  async chatMessages(apiKey: string, model: string, messages: readonly StructuredMessage[]): Promise<string> {
    if (preferResponsesForModel(model)) {
      return this.responsesText(apiKey, model, messages);
    }
    const response = await this.postChatCompletions(apiKey, model, messages, this.options.timeoutMs);
    if (response.ok) {
      const payload: unknown = await response.json().catch(() => undefined);
      const parsed = chatResponseSchema.safeParse(payload);
      if (parsed.success && parsed.data.choices[0] !== undefined) return parsed.data.choices[0].message.content;
      throw new ChatCompletionError(response.status);
    }
    if (await isResponsesOnlyError(response)) {
      return this.responsesText(apiKey, model, messages);
    }
    throw new ChatCompletionError(response.status);
  }

  private async postChatCompletions(
    apiKey: string,
    model: string,
    messages: readonly StructuredMessage[],
    timeoutMs: number,
  ): Promise<Response> {
    try {
      return await this.fetcher(`${this.options.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages, stream: false }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ChatCompletionError();
    }
  }

  private async responsesText(
    apiKey: string,
    model: string,
    messages: readonly StructuredMessage[],
    timeoutMs = this.options.timeoutMs,
  ): Promise<string> {
    const instructions = messages.filter((message) => message.role === "system")
      .map((message) => contentAsText(message.content)).join("\n\n");
    const input = messages.filter((message) => message.role !== "system").map((message) => ({
      role: message.role,
      content: responsesContent(message.content),
    }));
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, instructions, input, stream: false, store: false }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ChatCompletionError();
    }
    if (!response.ok) throw new ChatCompletionError(response.status);
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = responsesResponseSchema.safeParse(payload);
    if (!parsed.success) throw new ChatCompletionError(response.status);
    const text = responseOutputText(parsed.data);
    if (!text) throw new ChatCompletionError(response.status);
    return text;
  }

  async structuredChat(
    apiKey: string,
    model: string,
    messages: readonly StructuredMessage[],
    schemaName: string,
    schema: object,
    timeoutMs = this.options.timeoutMs,
  ): Promise<unknown> {
    if (preferResponsesForModel(model)) {
      const result = await this.structuredResponse(apiKey, model, messages, schemaName, schema, timeoutMs, { webSearch: false });
      return result.data;
    }
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
    if (!response.ok && await isResponsesOnlyError(response)) {
      const result = await this.structuredResponse(apiKey, model, messages, schemaName, schema, timeoutMs, { webSearch: false });
      return result.data;
    }
    if (!response.ok) throw new ChatCompletionError(response.status);
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

  async structuredResponse(
    apiKey: string,
    model: string,
    messages: readonly StructuredMessage[],
    schemaName: string,
    schema: object,
    timeoutMs = this.options.timeoutMs,
    options: { webSearch?: boolean } = {},
  ): Promise<StructuredResponseResult> {
    const instructions = messages
      .filter((message) => message.role === "system")
      .map((message) => contentAsText(message.content))
      .join("\n\n");
    const input = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role,
        content: responsesContent(message.content),
      }));
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          instructions,
          input,
          ...(options.webSearch === false ? {} : {
            tools: [{ type: "web_search" }],
            tool_choice: "auto",
          }),
          text: {
            format: { type: "json_schema", name: schemaName, strict: true, schema },
          },
          stream: false,
          store: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ChatCompletionError();
    }
    if (!response.ok) throw new ChatCompletionError(response.status);
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = responsesResponseSchema.safeParse(payload);
    if (!parsed.success) throw new ChatCompletionError(response.status);
    const text = responseOutputText(parsed.data);
    if (!text) throw new ChatCompletionError(response.status);
    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      throw new ChatCompletionError(response.status);
    }
    const searchCalls = parsed.data.output.filter((item) => item.type === "web_search_call");
    const sources = parsed.data.output.flatMap((item) => item.content ?? [])
      .flatMap((content) => content.annotations ?? [])
      .filter((annotation) => annotation.type === "url_citation")
      .map((annotation) => ({
        title: annotation.url_citation?.title ?? annotation.title ?? null,
        url: annotation.url_citation?.url ?? annotation.url ?? "",
      }))
      .filter((source) => source.url !== "")
      .filter((source, index, all) => all.findIndex((candidate) => candidate.url === source.url) === index);
    return {
      data,
      webSearch: {
        callCount: searchCalls.length,
        queries: searchCalls.map((item) => item.action?.query).filter((query): query is string => Boolean(query)),
        sources,
      },
    };
  }

  async vision(
    apiKey: string,
    model: string,
    instruction: string,
    images: readonly MediaBinary[],
    context: readonly StructuredMessage[] = [],
    locale?: string | null,
  ): Promise<string> {
    const content = [
      { type: "text", text: instruction },
      ...images.map((image) => ({
        type: "image_url",
        image_url: { url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}` },
      })),
    ];
    if (preferResponsesForModel(model)) {
      return this.responsesText(apiKey, model, [
        { role: "system", content: promptText("mia.system", locale) },
        ...context,
        { role: "user", content },
      ]);
    }
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: promptText("mia.system", locale) },
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
    if (!response.ok && await isResponsesOnlyError(response)) {
      return this.responsesText(apiKey, model, [
        { role: "system", content: promptText("mia.system", locale) },
        ...context,
        { role: "user", content },
      ]);
    }
    if (!response.ok) throw new ChatCompletionError(response.status);
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
  ): Promise<ImageSubmitResult> {
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
      const field = images.length === 1 ? "image" : "image[]";
      for (const image of images) {
        form.append(field, new Blob([Buffer.from(image.bytes)], { type: image.mimeType }), image.filename);
      }
      headers = { authorization: `Bearer ${apiKey}` };
      body = form;
    }
    const path = images.length === 0 ? "/v1/images/generations/async" : "/v1/images/edits";
    const response = await this.mediaFetch(
      path,
      apiKey,
      { method: "POST", headers, body },
      images.length > 0 ? Math.max(this.options.timeoutMs, IMAGE_EDIT_TIMEOUT_MS) : this.options.timeoutMs,
    );
    const payload: unknown = await response.json().catch(() => undefined);
    if (images.length > 0) {
      const parsed = imageEditResponseSchema.safeParse(payload);
      const result = parsed.success ? parsed.data.data[0] : undefined;
      if (!result) throw new MediaAPIError("invalid_submit_response", response.status);
      return {
        kind: "result",
        state: {
          status: "succeeded",
          progress: 100,
          resultUrl: result.url ?? null,
          resultBase64: result.b64_json ?? null,
          errorCode: null,
        },
      };
    }
    const parsed = imageSubmitResponseSchema.safeParse(payload);
    const taskId = parsed.success ? parsed.data.data[0]?.task_id : undefined;
    if (taskId === undefined) {
      throw new MediaAPIError("invalid_submit_response", response.status);
    }
    return { kind: "task", taskId };
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

  private async mediaFetch(
    path: string,
    apiKey: string,
    init: RequestInit = {},
    timeoutMs = this.options.timeoutMs,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.baseUrl}${path}`, {
        ...init,
        headers: init.headers ?? { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
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

function contentAsText(content: unknown): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

function responsesContent(content: unknown): unknown {
  if (!Array.isArray(content)) return contentAsText(content);
  return content.map((part: unknown) => {
    if (!part || typeof part !== "object") return { type: "input_text", text: String(part) };
    const value = part as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") {
      return { type: "input_text", text: value.text };
    }
    if (value.type === "image_url" && value.image_url && typeof value.image_url === "object") {
      const url = (value.image_url as Record<string, unknown>).url;
      if (typeof url === "string") return { type: "input_image", image_url: url };
    }
    return { type: "input_text", text: JSON.stringify(value) };
  });
}

function responseOutputText(payload: z.infer<typeof responsesResponseSchema>): string {
  if (payload.output_text) return payload.output_text;
  const outputText = payload.output.flatMap((item) => item.content ?? [])
    .filter((content) => content.type === "output_text" && typeof content.text === "string")
    .map((content) => content.text ?? "")
    .join("");
  return outputText;
}

function preferResponsesForModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === "grok-4.5"
    || normalized === "o3-pro"
    || normalized === "o3-deep-research"
    || normalized === "o4-mini-deep-research";
}

async function isResponsesOnlyError(response: Response): Promise<boolean> {
  if (![400, 404, 422].includes(response.status)) return false;
  const payload = await response.clone().json().catch(() => undefined) as Record<string, unknown> | undefined;
  const text = JSON.stringify(payload ?? "").toLowerCase();
  return text.includes("protocol_not_supported")
    || (text.includes("does not support") && text.includes("chat completions"))
    || (text.includes("不支持") && text.includes("chat completions"));
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
