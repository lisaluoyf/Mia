import { z } from "zod";

import type { APIMasterClient, MediaBinary, StructuredMessage } from "../clients/apimaster.js";
import { INTENT_ROUTER_SYSTEM_PROMPT } from "../prompts.js";

export const mediaIntentSchema = z.object({
  intent: z.enum(["chat", "image_generate", "image_edit", "vision_qa", "video_generate"]),
  confidence: z.number().min(0).max(1),
  instruction: z.string().max(8000),
  media_source: z.enum(["none", "message", "reply", "active_private_image"]),
  image_options: z.object({
    aspect_ratio: z.enum(["1:1", "16:9", "9:16"]).nullable(),
  }).nullable(),
  video_options: z.object({
    mode: z.enum(["text_to_video", "image_to_video"]),
    duration_seconds: z.number().int().nullable(),
    aspect_ratio: z.enum(["1:1", "16:9", "9:16"]).nullable(),
    resolution: z.string().nullable(),
    image_roles: z.array(z.enum(["first_frame", "last_frame", "reference_image"])).max(10),
  }).nullable(),
  final_response: z.string().max(20000).nullable().optional().default(null),
}).strict();

export type MediaIntent = z.infer<typeof mediaIntentSchema>;
export type IntentName = MediaIntent["intent"];
export type MediaSource = MediaIntent["media_source"];

export interface RouterContextMessage {
  role: "user" | "assistant";
  text: string;
}

export interface IntentRouterInput {
  text: string;
  mediaType: "none" | "image" | "video";
  mediaCount: number;
  replyMediaCount: number;
  replyToMessageId?: number | null;
  activePrivateImage: boolean;
  summary?: string | null;
  recentMessages?: readonly RouterContextMessage[];
  conversationMessages?: readonly StructuredMessage[];
}

export interface RoutedIntent extends MediaIntent {
  missingRequired: string[];
  fallbackReason?: "low_confidence" | "router_unavailable" | "invalid_output";
}

const ROUTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "confidence", "instruction", "media_source", "image_options", "video_options", "final_response"],
  properties: {
    intent: { type: "string", enum: ["chat", "image_generate", "image_edit", "vision_qa", "video_generate"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    instruction: { type: "string" },
    media_source: { type: "string", enum: ["none", "message", "reply", "active_private_image"] },
    image_options: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["aspect_ratio"],
          properties: { aspect_ratio: { type: ["string", "null"], enum: ["1:1", "16:9", "9:16", null] } },
        },
      ],
    },
    video_options: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["mode", "duration_seconds", "aspect_ratio", "resolution", "image_roles"],
          properties: {
            mode: { type: "string", enum: ["text_to_video", "image_to_video"] },
            duration_seconds: { type: ["integer", "null"] },
            aspect_ratio: { type: ["string", "null"], enum: ["1:1", "16:9", "9:16", null] },
            resolution: { type: ["string", "null"] },
            image_roles: {
              type: "array",
              maxItems: 10,
              items: { type: "string", enum: ["first_frame", "last_frame", "reference_image"] },
            },
          },
        },
      ],
    },
    final_response: { type: ["string", "null"] },
  },
} as const;

function fallback(reason: NonNullable<RoutedIntent["fallbackReason"]>): RoutedIntent {
  return {
    intent: "chat",
    confidence: 0,
    instruction: "",
    media_source: "none",
    image_options: null,
    video_options: null,
    final_response: null,
    missingRequired: [],
    fallbackReason: reason,
  };
}

export function validateIntentRequirements(intent: MediaIntent, input: IntentRouterInput): string[] {
  const missing: string[] = [];
  const hasImages = input.mediaCount > 0 || input.replyMediaCount > 0 || input.activePrivateImage;
  if (intent.intent !== "chat" && intent.instruction.trim() === "") {
    missing.push(intent.intent === "vision_qa" ? "question" : "instruction");
  }
  if ((intent.intent === "image_edit" || intent.intent === "vision_qa") && !hasImages) {
    missing.push("image");
  }
  if (intent.intent === "video_generate" && intent.video_options?.mode === "image_to_video" && !hasImages) {
    missing.push("image");
  }
  return [...new Set(missing)];
}

export class IntentRouter {
  constructor(
    private readonly client: Pick<APIMasterClient, "structuredChat">,
    private readonly options: { model: string; timeoutMs: number; confidenceThreshold?: number },
  ) {}

  get model(): string {
    return this.options.model;
  }

  async classify(input: IntentRouterInput, apiKey: string, images: readonly MediaBinary[] = []): Promise<RoutedIntent> {
    const contextPayload = {
      text: input.text,
      media: { type: input.mediaType, count: input.mediaCount },
      reply_media_count: input.replyMediaCount,
      reply_to_message_id: input.replyToMessageId ?? null,
      active_private_image: input.activePrivateImage,
      summary: input.summary ?? null,
      recent_messages: (input.recentMessages ?? []).slice(-8),
    };
    const userContent: unknown = images.length === 0 ? JSON.stringify(contextPayload) : [
      { type: "text", text: JSON.stringify(contextPayload) },
      ...images.map((image) => ({
        type: "image_url",
        image_url: { url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}` },
      })),
    ];
    const messages: StructuredMessage[] = input.conversationMessages === undefined ? [
      { role: "system", content: INTENT_ROUTER_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ] : [
      { role: "system", content: INTENT_ROUTER_SYSTEM_PROMPT },
      {
        role: "system",
        content: JSON.stringify({ current_request_routing_metadata: {
          media: { type: input.mediaType, count: input.mediaCount },
          reply_media_count: input.replyMediaCount,
          reply_to_message_id: input.replyToMessageId ?? null,
          active_private_image: input.activePrivateImage,
        } }),
      },
      ...input.conversationMessages,
    ];

    let raw: unknown;
    try {
      raw = await this.client.structuredChat(
        apiKey,
        this.options.model,
        messages,
        "mia_media_intent",
        ROUTER_SCHEMA,
        this.options.timeoutMs,
      );
    } catch {
      return fallback("router_unavailable");
    }
    const parsed = mediaIntentSchema.safeParse(raw);
    if (!parsed.success) {
      return fallback("invalid_output");
    }
    const returnsText = parsed.data.intent === "chat" || parsed.data.intent === "vision_qa";
    if ((returnsText && !parsed.data.final_response?.trim()) || (!returnsText && parsed.data.final_response !== null)) {
      return fallback("invalid_output");
    }
    if (parsed.data.confidence < (this.options.confidenceThreshold ?? 0.65)) {
      return { ...fallback("low_confidence"), instruction: input.text };
    }
    return {
      ...parsed.data,
      missingRequired: validateIntentRequirements(parsed.data, input),
    };
  }
}
