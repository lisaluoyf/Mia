import { z } from "zod";

import type { APIMasterClient, MediaBinary, StructuredMessage, WebSearchUsage } from "../clients/apimaster.js";
import { INTENT_ROUTER_SYSTEM_PROMPT } from "../prompts.js";

export const mediaIntentSchema = z.object({
  intent: z.enum(["chat", "group_summary", "image_generate", "image_edit", "vision_qa", "video_generate"]),
  confidence: z.number().min(0).max(1),
  instruction: z.string().max(8000),
  media_source: z.enum(["none", "message", "reply", "active_private_image", "context"]),
  media_message_ids: z.array(z.number().int().positive()).max(10).optional().default([]),
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
  conversation_mode: z.enum(["casual", "task"]).optional().default("task"),
  onboarding_opportunity: z.boolean().optional().default(false),
  profile_updates: z.object({
    preferred_name: z.string().trim().min(1).max(200).nullable(),
    primary_role: z.string().trim().min(1).max(500).nullable(),
    primary_goal: z.string().trim().min(1).max(1000).nullable(),
  }).strict().nullable().optional().default(null),
}).strict();

export type MediaIntent = z.infer<typeof mediaIntentSchema>;
export type IntentName = MediaIntent["intent"];
export type MediaSource = MediaIntent["media_source"];

export interface RouterContextMessage {
  role: "user" | "assistant";
  text: string;
  messageId?: number;
  senderUserId?: number | null;
  replyToMessageId?: number | null;
  contentType?: string;
  sentAt?: string;
}

export interface RouterMediaCandidate {
  messageId: number;
  senderUserId: number | null;
  type: "photo" | "document";
  sentAt: string;
  source: "current" | "reply" | "active_private_image" | "current_user_recent" | "topic_recent";
}

export interface IntentRouterInput {
  text: string;
  mediaType: "none" | "image" | "video";
  mediaCount: number;
  replyMediaCount: number;
  replyToMessageId?: number | null;
  activePrivateImage: boolean;
  allowGroupSummary?: boolean;
  summary?: string | null;
  recentMessages?: readonly RouterContextMessage[];
  mediaCandidates?: readonly RouterMediaCandidate[];
  mediaPixelsProvided?: boolean;
  conversationMessages?: readonly StructuredMessage[];
  onboarding?: {
    active: boolean;
    missingFields: readonly string[];
  };
}

export interface RoutedIntent extends MediaIntent {
  missingRequired: string[];
  fallbackReason?: "low_confidence" | "router_unavailable" | "invalid_output";
  webSearch?: WebSearchUsage;
}

const ROUTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "intent", "confidence", "instruction", "media_source", "media_message_ids", "image_options", "video_options", "final_response",
    "conversation_mode", "onboarding_opportunity", "profile_updates",
  ],
  properties: {
    intent: { type: "string", enum: ["chat", "group_summary", "image_generate", "image_edit", "vision_qa", "video_generate"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    instruction: { type: "string" },
    media_source: { type: "string", enum: ["none", "message", "reply", "active_private_image", "context"] },
    media_message_ids: {
      type: "array",
      maxItems: 10,
      items: { type: "integer", minimum: 1 },
    },
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
    conversation_mode: { type: "string", enum: ["casual", "task"] },
    onboarding_opportunity: { type: "boolean" },
    profile_updates: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["preferred_name", "primary_role", "primary_goal"],
          properties: {
            preferred_name: { type: ["string", "null"] },
            primary_role: { type: ["string", "null"] },
            primary_goal: { type: ["string", "null"] },
          },
        },
      ],
    },
  },
} as const;

function fallback(reason: NonNullable<RoutedIntent["fallbackReason"]>): RoutedIntent {
  return {
    intent: "chat",
    confidence: 0,
    instruction: "",
    media_source: "none",
    media_message_ids: [],
    image_options: null,
    video_options: null,
    final_response: null,
    conversation_mode: "task",
    onboarding_opportunity: false,
    profile_updates: null,
    missingRequired: [],
    fallbackReason: reason,
  };
}

export function validateIntentRequirements(intent: MediaIntent, input: IntentRouterInput): string[] {
  const missing: string[] = [];
  const hasImages = input.mediaCount > 0 || input.replyMediaCount > 0 || input.activePrivateImage ||
    (intent.media_message_ids?.length ?? 0) > 0;
  if (intent.intent !== "chat" && intent.intent !== "group_summary" && intent.instruction.trim() === "") {
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
    private readonly client: Pick<APIMasterClient, "structuredResponse">,
    private readonly options: { model: string; timeoutMs: number; confidenceThreshold?: number },
  ) {}

  get model(): string {
    return this.options.model;
  }

  async classify(
    input: IntentRouterInput,
    apiKey: string,
    images: readonly MediaBinary[] = [],
    model = this.options.model,
  ): Promise<RoutedIntent> {
    const mediaPixelsProvided = input.mediaPixelsProvided === true || images.length > 0;
    const recentMessages = (input.recentMessages ?? []).map((message) => ({
      role: message.role,
      text: message.text,
      message_id: message.messageId ?? null,
      sender_user_id: message.senderUserId ?? null,
      reply_to_message_id: message.replyToMessageId ?? null,
      content_type: message.contentType ?? null,
      sent_at: message.sentAt ?? null,
    }));
    const contextPayload = {
      text: input.text,
      media: { type: input.mediaType, count: input.mediaCount },
      reply_media_count: input.replyMediaCount,
      reply_to_message_id: input.replyToMessageId ?? null,
      active_private_image: input.activePrivateImage,
      media_pixels_provided: mediaPixelsProvided,
      media_candidates: (input.mediaCandidates ?? []).map((candidate) => ({
        message_id: candidate.messageId,
        sender_user_id: candidate.senderUserId,
        type: candidate.type,
        sent_at: candidate.sentAt,
        source: candidate.source,
      })),
      allow_group_summary: input.allowGroupSummary === true,
      summary: input.summary ?? null,
      recent_messages: recentMessages,
      onboarding: input.onboarding ?? { active: false, missingFields: [] },
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
          media_pixels_provided: mediaPixelsProvided,
          media_candidates: (input.mediaCandidates ?? []).map((candidate) => ({
            message_id: candidate.messageId,
            sender_user_id: candidate.senderUserId,
            type: candidate.type,
            sent_at: candidate.sentAt,
            source: candidate.source,
          })),
          recent_messages: recentMessages,
          allow_group_summary: input.allowGroupSummary === true,
          onboarding: input.onboarding ?? { active: false, missingFields: [] },
        } }),
      },
      ...input.conversationMessages,
    ];

    let raw: unknown;
    try {
      const result = await this.client.structuredResponse(
        apiKey,
        model,
        messages,
        "mia_media_intent",
        ROUTER_SCHEMA,
        this.options.timeoutMs,
      );
      raw = result.data;
      const parsed = mediaIntentSchema.safeParse(raw);
      if (!parsed.success) return fallback("invalid_output");
      return this.validatedResult(parsed.data, input, result.webSearch);
    } catch {
      return fallback("router_unavailable");
    }
  }

  private validatedResult(
    intent: MediaIntent,
    input: IntentRouterInput,
    webSearch: WebSearchUsage,
  ): RoutedIntent {
    if (intent.intent === "group_summary" && input.allowGroupSummary !== true) {
      return fallback("invalid_output");
    }
    const allowedMediaIds = new Set((input.mediaCandidates ?? []).map((candidate) => candidate.messageId));
    const selectedMediaIds = [...new Set(intent.media_message_ids ?? [])].filter((messageId) => allowedMediaIds.has(messageId));
    const normalizedIntent = { ...intent, media_message_ids: selectedMediaIds };
    const requiresFinalResponse = intent.intent === "chat" ||
      intent.intent === "vision_qa" && (input.mediaPixelsProvided === true || input.mediaCount > 0 || input.replyMediaCount > 0 || input.activePrivateImage);
    if ((requiresFinalResponse && !intent.final_response?.trim()) || (!requiresFinalResponse && intent.final_response !== null)) {
      return fallback("invalid_output");
    }
    if (intent.confidence < (this.options.confidenceThreshold ?? 0.65)) {
      return { ...fallback("low_confidence"), instruction: input.text };
    }
    return {
      ...normalizedIntent,
      missingRequired: validateIntentRequirements(normalizedIntent, input),
      webSearch,
    };
  }
}
