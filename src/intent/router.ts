import { z } from "zod";

import type { APIMasterClient, MediaBinary, StructuredMessage, WebSearchUsage } from "../clients/apimaster.js";
import { MIA_RESPONSE_JSON_SCHEMA, miaResponseFromText, miaResponseSchema } from "../presentation/schema.js";
import {
  FOLLOW_UP_CHAT_SYSTEM_PROMPT,
  FOLLOW_UP_PARTICIPATION_SYSTEM_PROMPT,
  INTENT_ROUTER_SYSTEM_PROMPT,
} from "../prompts.js";

const followUpDecisionSchema = z.object({
  should_respond: z.boolean(),
  response_to_message_id: z.number().int().positive().nullable(),
  intent_hint: z.enum(["chat", "media_or_summary"]),
  needs_web_search: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500),
}).strict();

const FOLLOW_UP_DECISION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "should_respond", "response_to_message_id", "intent_hint", "needs_web_search", "confidence", "reason",
  ],
  properties: {
    should_respond: { type: "boolean" },
    response_to_message_id: { type: ["integer", "null"], minimum: 1 },
    intent_hint: { type: "string", enum: ["chat", "media_or_summary"] },
    needs_web_search: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string", maxLength: 500 },
  },
} as const;

type FollowUpDecision = z.infer<typeof followUpDecisionSchema>;

function obviousFollowUpDecision(input: IntentRouterInput): FollowUpDecision | null {
  const batchIds = new Set(input.followUpBatchMessageIds ?? []);
  const recent = input.recentMessages ?? [];
  const batchMessages = recent.filter((message) => message.messageId !== undefined && batchIds.has(message.messageId));
  const target = batchMessages.at(-1);
  if (!target?.messageId || target.role !== "user") return null;
  const targetIndex = recent.lastIndexOf(target);
  const previous = targetIndex > 0 ? recent[targetIndex - 1] : undefined;
  const awakenedBy = input.followUpContext?.awakenedByUserId ?? null;
  if (awakenedBy !== null && target.senderUserId !== awakenedBy) return null;

  const text = target.text.trim();
  if (!text || /^(?:好|好的|行|可以|收到|谢谢|感谢|嗯|哦|ok|okay)[!！。.~～]*$/iu.test(text)) {
    return null;
  }
  if (previous?.role === "assistant" && Array.from(text).length <= 80) {
    const explicitContinuation = /^(?:那|那么|然后|接着|继续|再|还|也|改成|换成|补充|上面|刚才|前面|这个|那个|它)/u.test(text);
    const ellipticalQuestion = Array.from(text).length <= 40 &&
      /(?:呢|吗|么|如何|怎样|怎么样|怎么办|多少|几(?:点|天|个|次)|哪(?:里|个|天)|什么)(?:[?？!！。.]*)$/u.test(text);
    if (explicitContinuation || ellipticalQuestion) {
      return {
        should_respond: true,
        response_to_message_id: target.messageId,
        intent_hint: "chat",
        needs_web_search: /天气|气温|下雨|新闻|价格|比分|比赛|政策|今天|明天|后天|最新|现在|目前/u.test(`${previous.text}\n${text}`),
        confidence: 0.99,
        reason: "obvious_continuation_of_immediately_previous_mia_reply",
      };
    }
  }

  return null;
}

function withLegacyReply(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if ("reply" in record || !("final_response" in record)) return value;
  return {
    ...record,
    reply: typeof record.final_response === "string" && record.final_response.trim()
      ? miaResponseFromText(record.final_response)
      : null,
  };
}

export const mediaIntentSchema = z.preprocess(withLegacyReply, z.object({
  intent: z.enum(["chat", "group_summary", "image_generate", "image_edit", "sticker_create", "vision_qa", "video_generate"]),
  should_respond: z.boolean().optional().default(true),
  response_to_message_id: z.number().int().positive().nullable().optional().default(null),
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
  reply: miaResponseSchema.nullable().optional().default(null),
  final_response: z.string().max(20000).nullable().optional().default(null),
  conversation_mode: z.enum(["casual", "task"]).optional().default("task"),
  onboarding_opportunity: z.boolean().optional().default(false),
  profile_updates: z.object({
    preferred_name: z.string().trim().min(1).max(200).nullable(),
    primary_role: z.string().trim().min(1).max(500).nullable(),
    primary_goal: z.string().trim().min(1).max(1000).nullable(),
  }).strict().nullable().optional().default(null),
}).strict());

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
  participationMode?: "required" | "selective";
  followUpBatchMessageIds?: readonly number[];
  followUpContext?: {
    scopeType: "group" | "topic";
    chatId: number;
    threadId: number | null;
    awakenedByUserId: number | null;
    lastHandledAt: string;
  } | null;
  mediaType: "none" | "image" | "video";
  mediaCount: number;
  replyMediaCount: number;
  replyToMessageId?: number | null;
  repliedMessageText?: string | null;
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
  onParticipationDecision?: (responseToMessageId: number) => void | Promise<void>;
}

export interface RoutedIntent extends MediaIntent {
  missingRequired: string[];
  fallbackReason?: "low_confidence" | "router_unavailable" | "invalid_output" | "response_fallback";
  participationSource?: "heuristic" | "model";
  participationReason?: string;
  webSearch?: WebSearchUsage;
}

const ROUTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "intent", "should_respond", "response_to_message_id", "confidence", "instruction", "media_source",
    "media_message_ids", "image_options", "video_options", "reply",
    "conversation_mode", "onboarding_opportunity", "profile_updates",
  ],
  properties: {
    intent: { type: "string", enum: ["chat", "group_summary", "image_generate", "image_edit", "sticker_create", "vision_qa", "video_generate"] },
    should_respond: { type: "boolean" },
    response_to_message_id: { type: ["integer", "null"], minimum: 1 },
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
    reply: { anyOf: [{ type: "null" }, MIA_RESPONSE_JSON_SCHEMA] },
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

function fallback(
  reason: NonNullable<RoutedIntent["fallbackReason"]>,
  shouldRespond = true,
): RoutedIntent {
  return {
    intent: "chat",
    should_respond: shouldRespond,
    response_to_message_id: null,
    confidence: 0,
    instruction: "",
    media_source: "none",
    media_message_ids: [],
    image_options: null,
    video_options: null,
    reply: null,
    final_response: null,
    conversation_mode: "task",
    onboarding_opportunity: false,
    profile_updates: null,
    missingRequired: [],
    fallbackReason: reason,
  };
}

function observation(
  confidence: number,
  participationSource?: RoutedIntent["participationSource"],
  participationReason?: string,
): RoutedIntent {
  return {
    intent: "chat",
    should_respond: false,
    response_to_message_id: null,
    confidence,
    instruction: "",
    media_source: "none",
    media_message_ids: [],
    image_options: null,
    video_options: null,
    reply: null,
    final_response: null,
    conversation_mode: "task",
    onboarding_opportunity: false,
    profile_updates: null,
    missingRequired: [],
    ...(participationSource ? { participationSource } : {}),
    ...(participationReason ? { participationReason } : {}),
  };
}

function followUpChatResult(input: {
  targetMessageId: number;
  confidence: number;
  instruction: string;
  reply: z.infer<typeof miaResponseSchema>;
  webSearch?: WebSearchUsage;
  responseFallback?: boolean;
  participationSource: NonNullable<RoutedIntent["participationSource"]>;
  participationReason: string;
}): RoutedIntent {
  return {
    intent: "chat",
    should_respond: true,
    response_to_message_id: input.targetMessageId,
    confidence: input.confidence,
    instruction: input.instruction,
    media_source: "none",
    media_message_ids: [],
    image_options: null,
    video_options: null,
    reply: input.reply,
    final_response: null,
    conversation_mode: "task",
    onboarding_opportunity: false,
    profile_updates: null,
    missingRequired: [],
    participationSource: input.participationSource,
    participationReason: input.participationReason,
    ...(input.webSearch ? { webSearch: input.webSearch } : {}),
    ...(input.responseFallback ? { fallbackReason: "response_fallback" as const } : {}),
  };
}

export function validateIntentRequirements(intent: MediaIntent, input: IntentRouterInput): string[] {
  const missing: string[] = [];
  const hasImages = input.mediaCount > 0 || input.replyMediaCount > 0 || input.activePrivateImage ||
    (intent.media_message_ids?.length ?? 0) > 0;
  if (intent.intent !== "chat" && intent.intent !== "group_summary" && intent.intent !== "sticker_create" &&
      intent.instruction.trim() === "") {
    missing.push(intent.intent === "vision_qa" ? "question" : "instruction");
  }
  if ((intent.intent === "image_edit" || intent.intent === "sticker_create" || intent.intent === "vision_qa") && !hasImages) {
    missing.push("image");
  }
  if (intent.intent === "video_generate" && intent.video_options?.mode === "image_to_video" && !hasImages) {
    missing.push("image");
  }
  return [...new Set(missing)];
}

export class IntentRouter {
  constructor(
    private readonly client: Pick<APIMasterClient, "structuredResponse"> & Partial<Pick<APIMasterClient, "structuredChat">>,
    private readonly options: { model: string | (() => string); timeoutMs: number; confidenceThreshold?: number },
  ) {}

  get model(): string {
    return typeof this.options.model === "function" ? this.options.model() : this.options.model;
  }

  async classify(
    input: IntentRouterInput,
    apiKey: string,
    images: readonly MediaBinary[] = [],
    model = this.model,
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
    const participationMode = input.participationMode ?? "required";
    const followUpBatchMessageIds = [...new Set(input.followUpBatchMessageIds ?? [])];
    const followUpContext = input.followUpContext ?? null;
    const contextPayload = {
      current_request_text: input.text,
      replied_message_text: input.repliedMessageText ?? null,
      participation_mode: participationMode,
      follow_up_batch_message_ids: followUpBatchMessageIds,
      follow_up_context: followUpContext,
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
          current_request_text: input.text,
          replied_message_text: input.repliedMessageText ?? null,
          participation_mode: participationMode,
          follow_up_batch_message_ids: followUpBatchMessageIds,
          follow_up_context: followUpContext,
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

    if (participationMode === "selective") {
      return this.classifySelective(input, apiKey, model, contextPayload, messages);
    }

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

  private async classifySelective(
    input: IntentRouterInput,
    apiKey: string,
    model: string,
    contextPayload: Record<string, unknown>,
    fullMessages: readonly StructuredMessage[],
  ): Promise<RoutedIntent> {
    const batchIds = [...new Set(input.followUpBatchMessageIds ?? [])];
    let decision = obviousFollowUpDecision(input);
    let participationSource: NonNullable<RoutedIntent["participationSource"]> = decision ? "heuristic" : "model";
    if (!decision) {
      try {
        const decisionMessages: StructuredMessage[] = [
          { role: "system", content: FOLLOW_UP_PARTICIPATION_SYSTEM_PROMPT },
          ...fullMessages.filter((message, index) => !(index === 0 && message.role === "system")),
          { role: "user", content: JSON.stringify({
            follow_up_batch_message_ids: batchIds,
            follow_up_context: input.followUpContext ?? null,
            current_request_text: input.text,
            recent_messages: contextPayload.recent_messages,
          }) },
        ];
        const result = await this.structuredWithoutWebSearch(
          apiKey,
          model,
          decisionMessages,
          "mia_follow_up_participation",
          FOLLOW_UP_DECISION_JSON_SCHEMA,
          Math.min(this.options.timeoutMs, 30_000),
        );
        const parsed = followUpDecisionSchema.safeParse(result.data);
        if (!parsed.success) return fallback("invalid_output", false);
        decision = parsed.data;
        participationSource = "model";
      } catch {
        return fallback("router_unavailable", false);
      }
    }

    const targetMessageId = decision.response_to_message_id;
    const validTarget = targetMessageId !== null && batchIds.includes(targetMessageId);
    if (!decision.should_respond) {
      return decision.response_to_message_id === null
        ? observation(decision.confidence, participationSource, decision.reason)
        : fallback("invalid_output", false);
    }
    if (!validTarget) return fallback("invalid_output", false);
    if (targetMessageId === null) return fallback("invalid_output", false);
    if (decision.confidence < (this.options.confidenceThreshold ?? 0.65)) return fallback("low_confidence", false);
    try {
      await input.onParticipationDecision?.(targetMessageId);
    } catch {
      // Telegram typing indicators are best-effort and must not block a confirmed response.
    }

    if (decision.intent_hint === "media_or_summary") {
      const routed = await this.classifyFull(input, apiKey, model, fullMessages, false);
      if (routed.should_respond === false) {
        const usesCjk = /[\u3400-\u9fff\uf900-\ufaff]/u.test(input.text);
        return followUpChatResult({
          targetMessageId,
          confidence: decision.confidence,
          instruction: input.text,
          reply: miaResponseFromText(usesCjk
            ? "我看到了你的图片处理请求，但这次没有成功解析。请稍后再发一次。"
            : "I saw your image request, but could not parse it this time. Please try again shortly."),
          participationSource,
          participationReason: decision.reason,
          responseFallback: true,
        });
      }
      return { ...routed, participationSource, participationReason: decision.reason };
    }

    const answerMessages: StructuredMessage[] = [
      { role: "system", content: FOLLOW_UP_CHAT_SYSTEM_PROMPT },
      ...fullMessages.filter((message, index) => !(index === 0 && message.role === "system")),
      { role: "system", content: JSON.stringify({
        confirmed_follow_up: true,
        response_to_message_id: targetMessageId,
        needs_web_search: decision.needs_web_search,
      }) },
    ];
    try {
      const result = await this.client.structuredResponse(
        apiKey,
        model,
        answerMessages,
        "mia_follow_up_chat_response",
        MIA_RESPONSE_JSON_SCHEMA,
        Math.max(this.options.timeoutMs, 45_000),
      );
      const reply = miaResponseSchema.safeParse(result.data);
      if (!reply.success) return fallback("invalid_output", false);
      return followUpChatResult({
        targetMessageId,
        confidence: decision.confidence,
        instruction: input.text,
        reply: reply.data,
        participationSource,
        participationReason: decision.reason,
        webSearch: result.webSearch,
      });
    } catch {
      const usesCjk = /[\u3400-\u9fff\uf900-\ufaff]/u.test(input.text);
      return followUpChatResult({
        targetMessageId,
        confidence: decision.confidence,
        instruction: input.text,
        reply: miaResponseFromText(usesCjk
          ? "我看到了，这是在继续问我。不过公共模型这次响应失败了，请稍后再试一下。"
          : "I saw that this follows up on my answer, but the public model failed to respond this time. Please try again shortly."),
        participationSource,
        participationReason: decision.reason,
        responseFallback: true,
      });
    }
  }

  private async classifyFull(
    input: IntentRouterInput,
    apiKey: string,
    model: string,
    messages: readonly StructuredMessage[],
    allowWebSearch = true,
  ): Promise<RoutedIntent> {
    try {
      const result = allowWebSearch
        ? await this.client.structuredResponse(
          apiKey,
          model,
          messages,
          "mia_media_intent",
          ROUTER_SCHEMA,
          this.options.timeoutMs,
        )
        : await this.structuredWithoutWebSearch(
          apiKey,
          model,
          messages,
          "mia_media_intent",
          ROUTER_SCHEMA,
          this.options.timeoutMs,
        );
      const parsed = mediaIntentSchema.safeParse(result.data);
      if (!parsed.success) return fallback("invalid_output", false);
      return this.validatedResult(parsed.data, input, result.webSearch);
    } catch {
      return fallback("router_unavailable", false);
    }
  }

  private async structuredWithoutWebSearch(
    apiKey: string,
    model: string,
    messages: readonly StructuredMessage[],
    schemaName: string,
    schema: object,
    timeoutMs: number,
  ): Promise<{ data: unknown; webSearch: WebSearchUsage }> {
    if (this.client.structuredChat) {
      return {
        data: await this.client.structuredChat(apiKey, model, messages, schemaName, schema, timeoutMs),
        webSearch: { callCount: 0, queries: [], sources: [] },
      };
    }
    return this.client.structuredResponse(apiKey, model, messages, schemaName, schema, timeoutMs, { webSearch: false });
  }

  private validatedResult(
    intent: MediaIntent,
    input: IntentRouterInput,
    webSearch: WebSearchUsage,
  ): RoutedIntent {
    const selective = input.participationMode === "selective";
    if (!selective && !intent.should_respond) {
      return fallback("invalid_output");
    }
    const allowedResponseIds = new Set(input.followUpBatchMessageIds ?? []);
    if (selective && intent.should_respond &&
        (intent.response_to_message_id === null || !allowedResponseIds.has(intent.response_to_message_id))) {
      return fallback("invalid_output", false);
    }
    if ((!selective || !intent.should_respond) && intent.response_to_message_id !== null) {
      return fallback("invalid_output", !selective);
    }
    if (!intent.should_respond) {
      const validObservation = intent.intent === "chat" && intent.reply === null && intent.final_response === null &&
        intent.media_source === "none" && (intent.media_message_ids?.length ?? 0) === 0 &&
        intent.image_options === null && intent.video_options === null;
      return validObservation ? {
        ...intent,
        media_message_ids: [],
        missingRequired: [],
        webSearch,
      } : fallback("invalid_output", false);
    }
    if (intent.intent === "group_summary" && input.allowGroupSummary !== true) {
      return fallback("invalid_output", !selective);
    }
    const allowedMediaIds = new Set((input.mediaCandidates ?? []).map((candidate) => candidate.messageId));
    const selectedMediaIds = [...new Set(intent.media_message_ids ?? [])].filter((messageId) => allowedMediaIds.has(messageId));
    const normalizedIntent = { ...intent, media_message_ids: selectedMediaIds };
    const requiresReply = intent.intent === "chat" ||
      intent.intent === "vision_qa" && (input.mediaPixelsProvided === true || input.mediaCount > 0 || input.replyMediaCount > 0 || input.activePrivateImage);
    if ((requiresReply && intent.reply === null) || (!requiresReply && intent.reply !== null)) {
      return fallback("invalid_output", !selective);
    }
    if (intent.confidence < (this.options.confidenceThreshold ?? 0.65)) {
      return { ...fallback("low_confidence", !selective), instruction: input.text };
    }
    return {
      ...normalizedIntent,
      missingRequired: validateIntentRequirements(normalizedIntent, input),
      webSearch,
    };
  }
}
