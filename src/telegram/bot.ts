import { Bot, InlineKeyboard, InputFile, type Context, type Filter } from "grammy";
import type { Message } from "grammy/types";
import type { Logger } from "pino";

import type { APIMasterClient } from "../clients/apimaster.js";
import { ResolverError } from "../clients/apimaster.js";
import { DEFAULT_MODELS } from "../constants.js";
import { buildConversationMessages, loadConversationContext } from "../context/conversation.js";
import type { ContextCompactor } from "../context/compactor.js";
import { debugContextLayers } from "../debug/context.js";
import type { DebugRecorder } from "../debug/recorder.js";
import type { DebugContextLayers, DebugRequestKind } from "../debug/types.js";
import { mediaIntentSchema, type IntentRouter, type RoutedIntent } from "../intent/router.js";
import { MediaInputError, downloadConversationImages, downloadTelegramImages } from "../media/intake.js";
import type { MediaStore } from "../media/store.js";
import type { MediaInput, MediaJob, PendingMediaIntent } from "../media/types.js";
import { sameModelId, type ModelSettingsService, type SettingsSnapshot } from "../settings/service.js";
import type { ContextStore } from "../storage/store.js";
import type { ConversationScope } from "../storage/types.js";
import { MIA_SYSTEM_PROMPT, promptReference } from "../prompts.js";
import { botText, mediaJobLocale, resolveBotLocale, type BotLocale } from "./localization.js";
import { userFacingError } from "./messages.js";
import { promptFromMessage, shouldRespond } from "./policy.js";
import { splitText } from "./split-text.js";

type TextContext = Filter<Context, "message:text">;
type EditedTextContext = Filter<Context, "edited_message:text">;
type StorableMessage = Message.TextMessage | Message.PhotoMessage | Message.DocumentMessage | EditedTextContext["editedMessage"];

interface BotDependencies {
  client: APIMasterClient;
  logger: Logger;
  settings: Pick<ModelSettingsService, "getPreferences"> & Partial<Pick<ModelSettingsService, "getSnapshot">>;
  contexts: Pick<ContextStore, "upsertUser" | "upsertChat" | "upsertMember" | "saveMessage"> &
    Partial<Pick<ContextStore,
      "listRecentMessages" | "getLatestSummary" | "clearConversation" | "listMemories" |
      "listMessagesAfter" | "getMessage" | "listPendingCompletedTurns">>;
  compactor?: ContextCompactor;
  router?: IntentRouter;
  mediaStore?: MediaStore;
  botToken?: string;
  resultMaxBytes?: number;
  debug?: DebugRecorder;
}

interface IncomingRequest {
  ctx: Context;
  message: Message;
  text: string;
  inputs: MediaInput[];
}

type ContextReader = Pick<ContextStore,
  "getLatestSummary" | "listMemories" | "listMessagesAfter" | "listRecentMessages" |
  "getMessage" | "listPendingCompletedTurns">;

function mediaFromMessage(message: Message, position = 0): MediaInput | null {
  if ("photo" in message && message.photo.length > 0) {
    const photo = message.photo.at(-1);
    if (!photo) return null;
    return {
      position,
      messageId: message.message_id,
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      type: "photo",
      mimeType: "image/jpeg",
      mediaGroupId: message.media_group_id ?? null,
    };
  }
  if ("document" in message && message.document.mime_type?.startsWith("image/")) {
    return {
      position,
      messageId: message.message_id,
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id,
      type: "document",
      mimeType: message.document.mime_type,
      mediaGroupId: message.media_group_id ?? null,
    };
  }
  return null;
}

function captureMessage(message: StorableMessage, contexts: BotDependencies["contexts"]): void {
  const from = message.from;
  if (from) {
    contexts.upsertUser({
      telegramUserId: from.id,
      firstName: from.first_name,
      lastName: from.last_name ?? null,
      username: from.username ?? null,
      languageCode: from.language_code ?? null,
      isBot: from.is_bot,
    });
  }
  contexts.upsertChat({
    chatId: message.chat.id,
    type: message.chat.type,
    title: "title" in message.chat ? message.chat.title ?? null : null,
    username: "username" in message.chat ? message.chat.username ?? null : null,
    description: null,
    isForum: "is_forum" in message.chat ? message.chat.is_forum ?? false : false,
  });
  if (from) {
    contexts.upsertMember({ chatId: message.chat.id, telegramUserId: from.id, status: null });
  }
  const media = mediaFromMessage(message);
  contexts.saveMessage({
    chatId: message.chat.id,
    messageId: message.message_id,
    threadId: message.message_thread_id ?? null,
    senderUserId: from?.id ?? null,
    senderChatId: message.sender_chat?.id ?? null,
    replyToMessageId: message.reply_to_message?.message_id ?? null,
    contentType: media ? media.type : "text",
    text: "text" in message ? message.text : null,
    caption: "caption" in message ? message.caption ?? null : null,
    entitiesJson: "entities" in message && message.entities ? JSON.stringify(message.entities) :
      "caption_entities" in message && message.caption_entities ? JSON.stringify(message.caption_entities) : null,
    mediaFileId: media?.fileId ?? null,
    mediaUniqueId: media?.fileUniqueId ?? null,
    sentAt: new Date(message.date * 1000).toISOString(),
    editedAt: message.edit_date ? new Date(message.edit_date * 1000).toISOString() : null,
  });
}

function persistMessage(message: StorableMessage, dependencies: BotDependencies): boolean {
  try {
    captureMessage(message, dependencies.contexts);
    const media = mediaFromMessage(message);
    if (media && dependencies.mediaStore) {
      dependencies.mediaStore.saveTelegramMedia(message.chat.id, message.message_thread_id ?? null, media);
      if (message.chat.type === "private" && message.from) {
        dependencies.mediaStore.setActivePrivateImage({
          telegramUserId: message.from.id,
          chatId: message.chat.id,
          messageId: media.messageId,
          fileId: media.fileId,
          fileUniqueId: media.fileUniqueId,
          type: media.type,
          mimeType: media.mimeType,
          mediaGroupId: media.mediaGroupId,
        });
      }
    }
    return true;
  } catch (error) {
    dependencies.logger.error(
      { err: error, chatId: message.chat.id, messageId: message.message_id },
      "Failed to persist Telegram message context",
    );
    return false;
  }
}

export function createTextHandler(dependencies: BotDependencies) {
  return async (ctx: TextContext): Promise<void> => {
    persistMessage(ctx.message, dependencies);
    if (dependencies.router && dependencies.mediaStore && dependencies.botToken) {
      await handleIncoming({ ctx, message: ctx.message, text: ctx.message.text, inputs: [] }, dependencies);
      return;
    }
    const input = {
      chatType: ctx.chat.type,
      text: ctx.message.text,
      entities: ctx.message.entities,
      repliedToUserId: ctx.message.reply_to_message?.from?.id,
    };
    const identity = { id: ctx.me.id, username: ctx.me.username };
    if (!shouldRespond(input, identity)) return;
    await runChat(ctx, promptFromMessage(input, identity), dependencies);
  };
}

async function handleIncoming(request: IncomingRequest, dependencies: BotDependencies): Promise<void> {
  const { ctx, message } = request;
  if (!message.from || !ctx.me || !dependencies.mediaStore) return;
  const locale = resolveBotLocale(message.from.language_code);
  const entities = "entities" in message ? message.entities : "caption_entities" in message ? message.caption_entities : undefined;
  const policyInput = {
    chatType: message.chat.type,
    text: request.text,
    entities,
    repliedToUserId: message.reply_to_message?.from?.id,
  };
  const identity = { id: ctx.me.id, username: ctx.me.username };
  const explicit = parseExplicitCommand(request.text);
  const namedMediaReply = message.reply_to_message !== undefined && /^(?:@?mia)(?:\s|[,，:：])/i.test(request.text.trim());
  if (!shouldRespond(policyInput, identity) && !explicit && !namedMediaReply) return;

  if (explicit?.command === "media_on" || explicit?.command === "media_off") {
    await handleMediaAdmin(ctx, explicit.command === "media_on", dependencies.mediaStore);
    return;
  }
  if (explicit?.command === "new" || explicit?.command === "forget") {
    dependencies.mediaStore.clearPendingIntent(scopeFor(message));
    if (message.chat.type === "private") dependencies.mediaStore.clearActivePrivateImage(message.from.id, message.chat.id);
    dependencies.contexts.clearConversation?.(conversationScope(message));
    await replyTo(ctx, message, botText(locale, "contextCleared"));
    return;
  }

  const replyInputs = message.reply_to_message
    ? dependencies.mediaStore.getTelegramMedia(message.chat.id, message.reply_to_message.message_id)
    : [];
  const active = message.chat.type === "private" && request.inputs.length === 0 && replyInputs.length === 0
    ? dependencies.mediaStore.getActivePrivateImage(message.from.id, message.chat.id)
    : null;
  const activeInputs: MediaInput[] = active ? [{
    position: 0,
    messageId: active.messageId,
    fileId: active.fileId,
    fileUniqueId: active.fileUniqueId,
    type: active.type,
    mimeType: active.mimeType,
    mediaGroupId: active.mediaGroupId,
  }] : [];
  const pending = dependencies.mediaStore.getPendingIntent(scopeFor(message));
  const pendingInputs: MediaInput[] = [];
  if (pending) {
    for (const sourceMessageId of pending.sourceMessageIds) {
      pendingInputs.push(...dependencies.mediaStore.getTelegramMedia(message.chat.id, sourceMessageId));
    }
  }
  const chosenInputs = request.inputs.length > 0 ? request.inputs :
      replyInputs.length > 0 ? replyInputs :
        pendingInputs.length > 0 ? pendingInputs : activeInputs;
  if (chosenInputs.length > 10) {
    await replyTo(ctx, message, botText(locale, "maxImages"));
    return;
  }
  const inputs = normalizePositions(chosenInputs);
  const callbackReply = pending?.missingRequired.includes("callback_reply") === true &&
    pending.sourceMessageIds.at(-1) === message.reply_to_message?.message_id;
  const savedCallbackIntent = callbackReply ? mediaIntentSchema.safeParse(pending.slots) : null;

  if (request.inputs.length > 0 && request.text.trim() === "" && !pending) {
    await replyTo(ctx, message, botText(locale, "imageActionQuestion"));
    return;
  }

  let routed: RoutedIntent;
  if (savedCallbackIntent?.success) {
    routed = {
      ...savedCallbackIntent.data,
      instruction: request.text.trim(),
      missingRequired: request.text.trim() ? [] : ["instruction"],
    };
  } else if (explicit?.command === "image") {
    const image = parseImageOptions(explicit.instruction);
    routed = {
      ...directIntent(inputs.length > 0 ? "image_edit" : "image_generate", image.instruction, inputs.length > 0 ? "message" : "none"),
      image_options: { aspect_ratio: image.aspectRatio },
    };
  } else if (explicit?.command === "vision") {
    routed = directIntent("vision_qa", explicit.instruction, inputs.length > 0 ? "message" : "none");
  } else if (explicit?.command === "video") {
    const video = parseVideoOptions(explicit.instruction, inputs.length > 0);
    routed = {
      ...directIntent("video_generate", video.instruction, inputs.length > 0 ? "message" : "none"),
      video_options: video.options,
      missingRequired: video.instruction ? [] : ["instruction"],
    };
  } else {
    if (!dependencies.router) {
      await runChat(ctx, promptFromMessage(policyInput, identity), dependencies);
      return;
    }
    const scope = conversationScope(message);
    const recent = dependencies.contexts.listRecentMessages?.(scope, 8) ?? [];
    const summary = dependencies.contexts.getLatestSummary?.(scope)?.content ?? null;
    let debugId: string | null = null;
    try {
      await ctx.api.sendChatAction(message.chat.id, "typing", threadOption(message));
      const routerKey = await dependencies.client.resolveAPIKey(message.from.id, dependencies.router.model);
      const requestContext = await buildRequestContext(
        ctx,
        message,
        dependencies,
        activeInputs[0] ?? null,
        pending?.intent ?? null,
      );
      const fallbackImages = requestContext === null && inputs.length > 0
        ? await downloadTelegramImages(ctx.api, dependencies.botToken ?? "", inputs)
        : [];
      debugId = dependencies.debug?.start({
        telegramUserId: message.from.id,
        chatId: message.chat.id,
        chatType: message.chat.type,
        messageId: message.message_id,
        kind: "intent_router",
        model: dependencies.router.model,
        promptRefs: [promptReference("mia.system"), promptReference("mia.intent-router")],
        contextLayers: requestContext?.layers ?? null,
        requestPreview: { text: promptFromMessage(policyInput, identity), replyToMessageId: message.reply_to_message?.message_id ?? null },
        media: inputs.map((input) => ({ messageId: input.messageId, type: input.type, mimeType: input.mimeType })),
        details: { phase: "intent_and_response" },
      }) ?? null;
      routed = await dependencies.router.classify({
        text: promptFromMessage(policyInput, identity),
        mediaType: inputs.length > 0 ? "image" : "none",
        mediaCount: request.inputs.length,
        replyMediaCount: replyInputs.length,
        replyToMessageId: message.reply_to_message?.message_id ?? null,
        activePrivateImage: active !== null,
        summary,
        recentMessages: recent.map((item) => ({
          role: item.senderUserId === ctx.me.id ? "assistant" as const : "user" as const,
          text: item.text ?? item.caption ?? `[${item.contentType}]`,
        })),
        ...(requestContext ? { conversationMessages: requestContext.messages } : {}),
      }, routerKey, fallbackImages);
      const kind: DebugRequestKind = routed.intent === "chat" ? "chat" : routed.intent === "vision_qa" ? "vision_qa" : "intent_router";
      dependencies.debug?.finish(debugId, {
        status: "succeeded",
        responsePreview: routed,
        details: { phase: "intent_and_response", routedIntent: routed.intent, fallbackReason: routed.fallbackReason ?? null },
        kind,
      });
    } catch (error) {
      dependencies.debug?.finish(debugId, {
        status: "failed",
        errorCode: debugErrorCode(error),
      });
      await replyTo(ctx, message, error instanceof MediaInputError
        ? mediaError(error, locale)
        : userFacingError(error, dependencies.router.model, locale));
      return;
    }
    if (pending && routed.intent === "chat") {
      const saved = mediaIntentSchema.safeParse(pending.slots);
      if (saved.success) {
        routed = {
          ...saved.data,
          instruction: pending.missingRequired.some((field) => field === "instruction" || field === "question")
            ? request.text.trim()
            : saved.data.instruction,
          missingRequired: [],
        };
      }
    }
  }

  if (routed.intent === "chat") {
    if (routed.final_response) {
      const assistantMessageId = await sendConversationResponse(ctx, message, routed.final_response, dependencies);
      recordCompletedChatTurn(message, assistantMessageId, dependencies);
    } else {
      await runChat(ctx, promptFromMessage(policyInput, identity), dependencies);
    }
    return;
  }
  if (message.chat.type !== "private" && !dependencies.mediaStore.isGroupMediaEnabled(message.chat.id)) {
    await replyTo(ctx, message, botText(locale, "mediaDisabled"));
    return;
  }
  if (routed.intent === "vision_qa" && routed.final_response) {
    await sendConversationResponse(ctx, message, routed.final_response, dependencies);
    return;
  }

  const missing = [...routed.missingRequired];
  if ((routed.intent === "image_edit" || routed.intent === "vision_qa" ||
      routed.intent === "video_generate" && routed.video_options?.mode === "image_to_video") && inputs.length === 0) {
    missing.push("image");
  }
  if (routed.instruction.trim() === "" && !missing.includes("instruction") && !missing.includes("question")) {
    missing.push(routed.intent === "vision_qa" ? "question" : "instruction");
  }
  if (missing.length > 0) {
    dependencies.mediaStore.savePendingIntent({
      ...scopeFor(message),
      intent: routed.intent,
      slots: {
        intent: routed.intent,
        confidence: routed.confidence,
        instruction: routed.instruction,
        media_source: routed.media_source,
        image_options: routed.image_options,
        video_options: routed.video_options,
        final_response: routed.final_response,
      },
      missingRequired: [...new Set(missing)],
      sourceMessageIds: [message.message_id, ...inputs.map((input) => input.messageId)],
    });
    await replyTo(ctx, message, clarification(missing[0] ?? "instruction", locale));
    return;
  }
  dependencies.mediaStore.clearPendingIntent(scopeFor(message));
  await executeMediaIntent(ctx, message, routed, inputs, dependencies);
}

async function executeMediaIntent(
  ctx: Context,
  message: Message,
  routed: RoutedIntent,
  inputs: MediaInput[],
  dependencies: BotDependencies,
): Promise<void> {
  if (!message.from || !dependencies.mediaStore || !dependencies.botToken) return;
  const locale = resolveBotLocale(message.from.language_code);
  let debugId: string | null = null;
  try {
    const snapshot = dependencies.settings.getSnapshot
      ? await dependencies.settings.getSnapshot(message.from.id)
      : null;
    const capability = routed.intent === "vision_qa" ? "vision" : routed.intent === "video_generate" ? "video" : "image";
    if (snapshot?.unavailable.includes(capability)) {
      const fallbackModel = snapshot.settings[capability === "vision" ? "visionModel" : capability === "video" ? "videoModel" : "imageModel"];
      await replyTo(ctx, message, botText(locale, "modelUnavailable", {
        capability,
        model: fallbackModel ?? "the recommended model",
      }));
    }
    if (routed.intent === "vision_qa") {
      const model = snapshot?.settings.visionModel;
      if (!model) {
        await replyTo(ctx, message, botText(locale, "noVisionModel"));
        return;
      }
      await ctx.api.sendChatAction(message.chat.id, "typing", threadOption(message));
      const apiKey = await dependencies.client.resolveAPIKey(message.from.id, model);
      const activeMedia = inputs.find((input) => input.messageId !== message.message_id &&
        input.messageId !== message.reply_to_message?.message_id) ?? null;
      const requestContext = await buildRequestContext(ctx, message, dependencies, activeMedia, "vision_qa");
      debugId = dependencies.debug?.start({
        telegramUserId: message.from.id,
        chatId: message.chat.id,
        chatType: message.chat.type,
        messageId: message.message_id,
        kind: "vision_qa",
        model,
        promptRefs: [promptReference("mia.system")],
        contextLayers: requestContext?.layers ?? null,
        requestPreview: { instruction: routed.instruction },
        media: inputs.map((input) => ({ messageId: input.messageId, type: input.type, mimeType: input.mimeType })),
      }) ?? null;
      const response = requestContext
        ? await dependencies.client.chatMessages(apiKey, model, [
          { role: "system", content: MIA_SYSTEM_PROMPT },
          ...requestContext.messages,
        ])
        : await dependencies.client.vision(
          apiKey,
          model,
          routed.instruction,
          await downloadTelegramImages(ctx.api, dependencies.botToken, inputs),
        );
      dependencies.debug?.finish(debugId, { status: "succeeded", responsePreview: response });
      await sendConversationResponse(ctx, message, response, dependencies);
      return;
    }
    if (routed.intent === "video_generate") {
      await createVideoDraft(ctx, message, routed, inputs, snapshot, dependencies);
      return;
    }
    if (routed.intent !== "image_generate" && routed.intent !== "image_edit") return;
    const model = snapshot?.settings.imageModel ?? dependencies.settings.getPreferences(message.from.id).imageModel ?? DEFAULT_MODELS.image;
    if (dependencies.mediaStore.getJobByIdempotencyKey(requestKey(message))) return;
    const status = await replyTo(ctx, message, botText(locale, "stillProcessing", { progress: "" }));
    const claim = dependencies.mediaStore.claimJob({
      ...scopeFor(message),
      type: routed.intent,
      idempotencyKey: requestKey(message),
      requestMessageId: message.message_id,
      statusMessageId: status.message_id,
      model,
      instruction: routed.instruction,
      options: { aspectRatio: routed.image_options?.aspect_ratio ?? "1:1", locale },
    }, inputs);
    if (claim.outcome === "limit_reached") {
      await ctx.api.editMessageText(message.chat.id, status.message_id, botText(locale, "activeLimit"));
    } else if (claim.outcome === "existing") {
      await ctx.api.editMessageText(message.chat.id, status.message_id, botText(locale, "requestAlready", {
        status: claim.job.status,
      }));
    }
  } catch (error) {
    dependencies.debug?.finish(debugId, { status: "failed", errorCode: debugErrorCode(error) });
    await replyTo(ctx, message, mediaError(error, locale));
  }
}

async function createVideoDraft(
  ctx: Context,
  message: Message,
  routed: RoutedIntent,
  inputs: MediaInput[],
  snapshot: SettingsSnapshot | null,
  dependencies: BotDependencies,
): Promise<void> {
  if (!message.from || !dependencies.mediaStore) return;
  const locale = resolveBotLocale(message.from.language_code);
  const model = snapshot?.settings.videoModel ?? dependencies.settings.getPreferences(message.from.id).videoModel ?? DEFAULT_MODELS.video;
  const modelOption = snapshot?.models.find((item) => sameModelId(item.id, model));
  const caps = modelOption?.videoCapabilities;
  if (snapshot && !caps) {
    await replyTo(ctx, message, botText(locale, "videoMetadataMissing"));
    return;
  }
  const duration = routed.video_options?.duration_seconds ?? caps?.durationSeconds.default ?? 4;
  const ratio = routed.video_options?.aspect_ratio ?? caps?.defaultAspectRatio ?? "16:9";
  const resolution = routed.video_options?.resolution ?? caps?.defaultResolution ?? "768P";
  if (duration < (caps?.durationSeconds.min ?? 4) || duration > (caps?.durationSeconds.max ?? 15) ||
      !(caps?.aspectRatios ?? ["1:1", "16:9", "9:16"]).includes(ratio) ||
      !(caps?.resolutions ?? ["768P"]).includes(resolution) || inputs.length > (caps?.maxReferenceImages ?? 10)) {
    await replyTo(ctx, message, botText(locale, "unsupportedVideo"));
    return;
  }
  const draft = dependencies.mediaStore.createDraft({
    ...scopeFor(message),
    type: "video_generate",
    idempotencyKey: requestKey(message),
    requestMessageId: message.message_id,
    model,
    instruction: routed.instruction,
    options: {
      durationSeconds: duration,
      aspectRatio: ratio,
      resolution,
      mode: inputs.length > 0 ? "image_to_video" : "text_to_video",
      locale,
    },
  }, inputs);
  if (draft.status !== "draft" || draft.statusMessageId !== null) return;
  const sent = await replyTo(ctx, message, videoDraftText(draft), { reply_markup: draftKeyboard(draft) });
  dependencies.mediaStore.updateDraft(draft.id, draft.options, sent.message_id);
}

async function handleCallback(ctx: Context, dependencies: BotDependencies): Promise<void> {
  const query = ctx.callbackQuery;
  if (!query || !query.data || !query.from || !dependencies.mediaStore) return;
  const match = /^media:(\d+):(generate|cancel|dur_up|dur_down|ratio|download|again|edit)$/.exec(query.data);
  if (!match) return;
  const jobId = Number(match[1]);
  const action = match[2];
  const job = dependencies.mediaStore.getJob(jobId);
  const locale = job ? mediaJobLocale(job.options, query.from.language_code) : resolveBotLocale(query.from.language_code);
  if (!job || job.telegramUserId !== query.from.id) {
    await ctx.answerCallbackQuery({ text: botText(locale, "actionUnavailable"), show_alert: true });
    return;
  }
  if (action === "generate") {
    const result = dependencies.mediaStore.claimDraft(job.id);
    if (result.outcome === "claimed") {
      const processingText = botText(locale, "stillProcessing", { progress: "" });
      await ctx.answerCallbackQuery({ text: processingText });
      await editCallbackMessage(ctx, processingText);
    } else if (result.outcome === "limit_reached") {
      await ctx.answerCallbackQuery({ text: botText(locale, "activeLimit"), show_alert: true });
    } else {
      await ctx.answerCallbackQuery({ text: botText(locale, "draftExpiredOrUsed"), show_alert: true });
    }
    return;
  }
  if (action === "cancel") {
    const cancelled = dependencies.mediaStore.transitionJob(job.id, ["draft"], "expired");
    await ctx.answerCallbackQuery({ text: botText(locale, cancelled ? "cancelled" : "draftUnavailable") });
    if (cancelled) await editCallbackMessage(ctx, botText(locale, "videoDraftCancelled"));
    return;
  }
  if (action === "dur_up" || action === "dur_down" || action === "ratio") {
    if (job.status !== "draft") {
      await ctx.answerCallbackQuery({ text: botText(locale, "draftUnavailable"), show_alert: true });
      return;
    }
    const options = { ...job.options };
    if (action === "ratio") {
      const ratios = ["1:1", "16:9", "9:16"];
      options.aspectRatio = ratios[(ratios.indexOf(String(options.aspectRatio)) + 1) % ratios.length];
    } else {
      const delta = action === "dur_up" ? 1 : -1;
      options.durationSeconds = Math.max(4, Math.min(15, Number(options.durationSeconds ?? 4) + delta));
    }
    const updated = dependencies.mediaStore.updateDraft(job.id, options);
    await ctx.answerCallbackQuery();
    if (updated && query.message) {
      await ctx.api.editMessageText(query.message.chat.id, query.message.message_id, videoDraftText(updated), {
        reply_markup: draftKeyboard(updated),
      });
    }
    return;
  }
  if (action === "edit") {
    const resultMessageId = query.message?.message_id ?? job.statusMessageId;
    if (job.type === "video_generate" || !resultMessageId ||
        dependencies.mediaStore.getTelegramMedia(job.chatId, resultMessageId).length === 0) {
      await ctx.answerCallbackQuery({ text: botText(locale, "actionUnavailable"), show_alert: true });
      return;
    }
    dependencies.mediaStore.savePendingIntent({
      ...scopeForJob(job),
      intent: "image_edit",
      slots: {
        intent: "image_edit",
        confidence: 1,
        instruction: "",
        media_source: "reply",
        image_options: { aspect_ratio: null },
        video_options: null,
        final_response: null,
      },
      missingRequired: ["instruction"],
      sourceMessageIds: [resultMessageId],
    });
    await ctx.answerCallbackQuery();
    const displayName = query.from.first_name.trim() || query.from.username || "User";
    const instruction = botText(locale, "editInstruction");
    try {
      const prompt = await ctx.api.sendMessage(job.chatId, `${displayName}: ${instruction}`, {
        ...threadOptionFromJob(job),
        reply_parameters: { message_id: resultMessageId, allow_sending_without_reply: true },
        entities: [{
          type: "text_mention",
          offset: 0,
          length: displayName.length,
          user: query.from,
        }],
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: botText(locale, "continueEditing"),
        },
      });
      dependencies.mediaStore.savePendingIntent({
        ...scopeForJob(job),
        intent: "image_edit",
        slots: {
          intent: "image_edit",
          confidence: 1,
          instruction: "",
          media_source: "reply",
          image_options: { aspect_ratio: null },
          video_options: null,
          final_response: null,
        },
        missingRequired: ["instruction", "callback_reply"],
        sourceMessageIds: [resultMessageId, prompt.message_id],
      });
    } catch (error) {
      dependencies.mediaStore.clearPendingIntent(scopeForJob(job));
      throw error;
    }
    return;
  }
  if (action === "again") {
    const resultMessageId = query.message?.message_id ?? job.statusMessageId;
    if (!resultMessageId) {
      await ctx.answerCallbackQuery({ text: botText(locale, "actionUnavailable"), show_alert: true });
      return;
    }
    if (job.type === "video_generate") {
      const draft = dependencies.mediaStore.createDraft({
        ...scopeForJob(job),
        type: "video_generate",
        idempotencyKey: `callback:${query.id}`,
        requestMessageId: resultMessageId,
        model: job.model,
        instruction: job.instruction,
        options: job.options,
      }, dependencies.mediaStore.listJobInputs(job.id));
      const sent = await ctx.api.sendMessage(job.chatId, videoDraftText(draft), {
        ...threadOptionFromJob(job),
        reply_parameters: { message_id: resultMessageId, allow_sending_without_reply: true },
        reply_markup: draftKeyboard(draft),
      });
      dependencies.mediaStore.updateDraft(draft.id, draft.options, sent.message_id);
      await ctx.answerCallbackQuery({ text: botText(locale, "draftCreated") });
      return;
    }
    await ctx.answerCallbackQuery();
    const status = await ctx.api.sendMessage(job.chatId, botText(locale, "generatingNewImage"), {
      ...threadOptionFromJob(job),
      reply_parameters: { message_id: resultMessageId, allow_sending_without_reply: true },
    });
    const claim = dependencies.mediaStore.claimJob({
      ...scopeForJob(job),
      type: job.type,
      idempotencyKey: `callback:${query.id}`,
      requestMessageId: resultMessageId,
      statusMessageId: status.message_id,
      model: job.model,
      instruction: job.instruction,
      options: { ...job.options, ephemeralStatus: true },
    }, dependencies.mediaStore.listJobInputs(job.id));
    if (claim.outcome === "limit_reached") {
      await ctx.api.editMessageText(job.chatId, status.message_id, botText(locale, "jobsAlreadyRunning"));
    } else if (claim.outcome === "existing") {
      await ctx.api.editMessageText(job.chatId, status.message_id, botText(locale, "requestAlready", {
        status: claim.job.status,
      }));
    }
    return;
  }
  if (action === "download") {
    await downloadResult(ctx, job, dependencies);
  }
}

async function downloadResult(ctx: Context, job: MediaJob, dependencies: BotDependencies): Promise<void> {
  if (!ctx.callbackQuery || !dependencies.resultMaxBytes || !dependencies.mediaStore) {
    const locale = mediaJobLocale(job.options, ctx.from?.language_code);
    await ctx.answerCallbackQuery({ text: botText(locale, "originalUnavailable"), show_alert: true });
    return;
  }
  const locale = mediaJobLocale(job.options, ctx.from?.language_code);
  try {
    const local = dependencies.mediaStore.readLocalResult(job.id, job.resultMimeType);
    if (local) {
      await ctx.api.sendDocument(job.chatId, new InputFile(local.bytes, local.filename), threadOptionFromJob(job));
      await ctx.answerCallbackQuery({ text: botText(locale, "sent") });
      return;
    }
    if (!job.resultUrl) {
      await ctx.answerCallbackQuery({ text: botText(locale, "originalUnavailable"), show_alert: true });
      return;
    }
    const apiKey = await dependencies.client.resolveAPIKey(job.telegramUserId, job.model);
    const media = await dependencies.client.getContent(apiKey, job.resultUrl, dependencies.resultMaxBytes);
    await ctx.api.sendDocument(job.chatId, new InputFile(media.bytes, media.filename), threadOptionFromJob(job));
    await ctx.answerCallbackQuery({ text: botText(locale, "sent") });
  } catch {
    await ctx.answerCallbackQuery({ text: botText(locale, "downloadUnavailable"), show_alert: true });
  }
}

async function handleMediaAdmin(ctx: Context, enabled: boolean, store: MediaStore): Promise<void> {
  const message = ctx.message;
  if (!message?.from || message.chat.type === "private") return;
  const locale = resolveBotLocale(message.from.language_code);
  const member = await ctx.api.getChatMember(message.chat.id, message.from.id);
  if (member.status !== "creator" && member.status !== "administrator") {
    await replyTo(ctx, message, botText(locale, "adminOnly"));
    return;
  }
  store.setGroupMediaEnabled(message.chat.id, enabled);
  await replyTo(ctx, message, botText(locale, enabled ? "mediaEnabled" : "mediaDisabledConfirmation"));
}

async function runChat(ctx: Context, prompt: string, dependencies: BotDependencies): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  const locale = resolveBotLocale(ctx.from.language_code);
  let debugId: string | null = null;
  try {
    await ctx.api.sendChatAction(ctx.chat.id, "typing", ctx.message ? threadOption(ctx.message) : {});
    const selectedModel = dependencies.settings.getPreferences(ctx.from.id).chatModel ?? DEFAULT_MODELS.chat;
    let model = selectedModel;
    let apiKey: string;
    try {
      apiKey = await dependencies.client.resolveAPIKey(ctx.from.id, model);
    } catch (error) {
      if (!(error instanceof ResolverError) || error.code !== "no_usable_api_key" || sameModelId(model, DEFAULT_MODELS.chat)) throw error;
      model = DEFAULT_MODELS.chat;
      apiKey = await dependencies.client.resolveAPIKey(ctx.from.id, model);
      await ctx.reply(botText(locale, "chatModelFallback", { selected: selectedModel, model }));
    }
    if (!ctx.message) return;
    const requestContext = await buildRequestContext(ctx, ctx.message, dependencies, null, null);
    debugId = dependencies.debug?.start({
      telegramUserId: ctx.from.id,
      chatId: ctx.chat.id,
      chatType: ctx.chat.type,
      messageId: ctx.message.message_id,
      kind: "chat",
      model,
      promptRefs: [promptReference("mia.system")],
      contextLayers: requestContext?.layers ?? null,
      requestPreview: { text: prompt },
      media: requestContext?.layers.recentMessages ?? null,
    }) ?? null;
    const response = requestContext
      ? await dependencies.client.chatMessages(apiKey, model, [
        { role: "system", content: MIA_SYSTEM_PROMPT },
        ...requestContext.messages,
      ])
      : await dependencies.client.chat(apiKey, model, prompt);
    dependencies.debug?.finish(debugId, { status: "succeeded", responsePreview: response });
    const assistantMessageId = await sendConversationResponse(ctx, ctx.message, response, dependencies);
    recordCompletedChatTurn(ctx.message, assistantMessageId, dependencies);
  } catch (error) {
    dependencies.debug?.finish(debugId, { status: "failed", errorCode: debugErrorCode(error) });
    dependencies.logger.warn({ err: error, telegramUserId: ctx.from.id, updateId: ctx.update.update_id }, "Telegram chat request failed");
    const model = dependencies.settings.getPreferences(ctx.from.id).chatModel ?? DEFAULT_MODELS.chat;
    await ctx.reply(userFacingError(error, model, locale));
  }
}

function hasContextReader(contexts: BotDependencies["contexts"]): contexts is BotDependencies["contexts"] & ContextReader {
  return typeof contexts.getLatestSummary === "function" &&
    typeof contexts.listMemories === "function" &&
    typeof contexts.listMessagesAfter === "function" &&
    typeof contexts.listRecentMessages === "function" &&
    typeof contexts.getMessage === "function" &&
    typeof contexts.listPendingCompletedTurns === "function";
}

async function buildRequestContext(
  ctx: Context,
  message: Message,
  dependencies: BotDependencies,
  activeMedia: MediaInput | null,
  currentTask: string | null,
): Promise<{ messages: ReturnType<typeof buildConversationMessages>; layers: DebugContextLayers } | null> {
  if (!message.from || !ctx.me || !dependencies.botToken || !hasContextReader(dependencies.contexts)) return null;
  const context = loadConversationContext({
    store: dependencies.contexts,
    scope: conversationScope(message),
    userId: message.from.id,
    currentMessageId: message.message_id,
    replyToMessageId: message.reply_to_message?.message_id ?? null,
    activeMedia,
    metadata: {
      chatType: message.chat.type,
      chatTitle: "title" in message.chat ? message.chat.title ?? null : null,
      currentUser: message.from.username ?? message.from.first_name,
      language: message.from.language_code ?? null,
      currentTime: new Date().toISOString(),
      timezone: null,
      trigger: message.reply_to_message ? "reply" : "message",
      currentTask,
    },
  }, ctx.me.id);
  const requiredMediaMessageIds = new Set([
    context.currentMessageId,
    context.replyToMessageId,
    context.activeMediaMessageId,
  ].filter((messageId): messageId is number => messageId !== null));
  const images = context.mediaInputs.length === 0
    ? []
    : await downloadConversationImages(
      ctx.api,
      dependencies.botToken,
      context.mediaInputs,
      requiredMediaMessageIds,
    );
  return {
    messages: buildConversationMessages(context, images, ctx.me.id),
    layers: debugContextLayers(context),
  };
}

function debugErrorCode(error: unknown): string {
  if (error instanceof ResolverError) return error.code;
  if (error instanceof MediaInputError) return error.code;
  if (error instanceof Error && error.name) return error.name.slice(0, 80);
  return "unknown_error";
}

function recordCompletedChatTurn(
  message: Message,
  assistantMessageId: number | null,
  dependencies: BotDependencies,
): void {
  if (!message.from || message.chat.type !== "private" || !dependencies.compactor || assistantMessageId === null) return;
  dependencies.compactor.recordSuccessfulPrivateTurn({
    chatId: message.chat.id,
    userId: message.from.id,
    userMessageId: message.message_id,
    assistantMessageId,
  });
}

async function sendConversationResponse(
  ctx: Context,
  message: Message,
  response: string,
  dependencies: BotDependencies,
): Promise<number | null> {
  let lastMessageId: number | null = null;
  let allPersisted = true;
  for (const chunk of splitText(response)) {
    const sent = await replyTo(ctx, message, chunk);
    allPersisted = persistMessage(sent, dependencies) && allPersisted;
    lastMessageId = sent.message_id;
  }
  return allPersisted ? lastMessageId : null;
}

function directIntent(intent: PendingMediaIntent, instruction: string, mediaSource: RoutedIntent["media_source"]): RoutedIntent {
  return {
    intent,
    confidence: 1,
    instruction,
    media_source: mediaSource,
    image_options: intent === "image_generate" || intent === "image_edit" ? { aspect_ratio: null } : null,
    video_options: intent === "video_generate" ? {
      mode: mediaSource === "none" ? "text_to_video" : "image_to_video",
      duration_seconds: null,
      aspect_ratio: null,
      resolution: null,
      image_roles: [],
    } : null,
    final_response: null,
    missingRequired: instruction.trim() ? [] : [intent === "vision_qa" ? "question" : "instruction"],
  };
}

function parseExplicitCommand(text: string): { command: string; instruction: string } | null {
  const match = /^\/(image|vision|video|new|forget|media_on|media_off)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { command: match[1]?.toLowerCase() ?? "", instruction: match[2]?.trim() ?? "" } : null;
}

function parseVideoOptions(text: string, hasImages: boolean) {
  const duration = /(?:^|\s)(\d{1,2})\s*(?:s|sec|seconds?|秒)(?:\s|$)/i.exec(text)?.[1];
  const ratio = /(?:^|\s)(1:1|16:9|9:16)(?:\s|$)/.exec(text)?.[1] as "1:1" | "16:9" | "9:16" | undefined;
  const resolution = /(?:^|\s)(768p|2k|4k)(?:\s|$)/i.exec(text)?.[1]?.toUpperCase();
  const instruction = text
    .replace(/(?:^|\s)\d{1,2}\s*(?:s|sec|seconds?|秒)(?=\s|$)/ig, " ")
    .replace(/(?:^|\s)(?:1:1|16:9|9:16|768p|2k|4k)(?=\s|$)/ig, " ")
    .trim();
  return {
    instruction,
    options: {
      mode: hasImages ? "image_to_video" as const : "text_to_video" as const,
      duration_seconds: duration ? Number(duration) : null,
      aspect_ratio: ratio ?? null,
      resolution: resolution ?? null,
      image_roles: [],
    },
  };
}

function parseImageOptions(text: string): { instruction: string; aspectRatio: "1:1" | "16:9" | "9:16" | null } {
  const ratio = /(?:^|\s)(1:1|16:9|9:16)(?:\s|$)/.exec(text)?.[1] as "1:1" | "16:9" | "9:16" | undefined;
  return {
    instruction: text.replace(/(?:^|\s)(?:1:1|16:9|9:16)(?=\s|$)/g, " ").trim(),
    aspectRatio: ratio ?? null,
  };
}

function videoDraftText(job: MediaJob): string {
  const locale = mediaJobLocale(job.options);
  const mode = String(job.options.mode) === "image_to_video"
    ? botText(locale, "modeImageToVideo")
    : botText(locale, "modeTextToVideo");
  return [
    botText(locale, "videoDraftTitle"),
    botText(locale, "modelLabel", { value: job.model }),
    botText(locale, "modeLabel", { value: mode }),
    botText(locale, "promptLabel", { value: job.instruction }),
    botText(locale, "durationLabel", { value: String(job.options.durationSeconds) }),
    botText(locale, "aspectRatioLabel", { value: String(job.options.aspectRatio) }),
    botText(locale, "resolutionLabel", { value: String(job.options.resolution) }),
    botText(locale, "draftExpires"),
  ].join("\n");
}

function draftKeyboard(job: MediaJob): InlineKeyboard {
  const locale = mediaJobLocale(job.options);
  return new InlineKeyboard()
    .text("-1s", `media:${job.id}:dur_down`).text("+1s", `media:${job.id}:dur_up`)
    .text(botText(locale, "ratioButton"), `media:${job.id}:ratio`).row()
    .text(botText(locale, "generateVideoButton"), `media:${job.id}:generate`)
    .text(botText(locale, "cancelButton"), `media:${job.id}:cancel`);
}

function requestKey(message: Message): string {
  return message.media_group_id ? `album:${message.chat.id}:${message.media_group_id}` : `message:${message.chat.id}:${message.message_id}`;
}

function normalizePositions(inputs: readonly MediaInput[]): MediaInput[] {
  return inputs.slice(0, 10).map((input, position) => ({ ...input, position }));
}

function scopeFor(message: Message) {
  if (!message.from) throw new Error("message sender required");
  return { telegramUserId: message.from.id, chatId: message.chat.id, threadId: message.message_thread_id ?? null };
}

function scopeForJob(job: MediaJob) {
  return { telegramUserId: job.telegramUserId, chatId: job.chatId, threadId: job.threadId };
}

function conversationScope(message: Message): ConversationScope {
  if (message.chat.type === "private") return { type: "private", chatId: message.chat.id };
  return message.message_thread_id ? { type: "topic", chatId: message.chat.id, threadId: message.message_thread_id } : { type: "group", chatId: message.chat.id };
}

function threadOption(message: Message) {
  return message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id };
}

function threadOptionFromJob(job: MediaJob) {
  return job.threadId === null ? {} : { message_thread_id: job.threadId };
}

function replyTo(ctx: Context, message: Message, text: string, extra: Record<string, unknown> = {}) {
  return ctx.api.sendMessage(message.chat.id, text, {
    ...threadOption(message),
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    ...extra,
  });
}

function clarification(field: string, locale: BotLocale): string {
  if (field === "image") return botText(locale, "clarificationImage");
  if (field === "question") return botText(locale, "clarificationQuestion");
  return botText(locale, "clarificationInstruction");
}

function mediaError(error: unknown, locale: BotLocale): string {
  if (error instanceof MediaInputError) {
    if (error.code === "too_many_images") return botText(locale, "tooManyImages");
    if (error.code === "file_too_large") return botText(locale, "fileTooLarge");
    if (error.code === "total_too_large") return botText(locale, "totalTooLarge");
    return botText(locale, "unsupportedImage");
  }
  return userFacingError(error, undefined, locale);
}

async function editCallbackMessage(ctx: Context, text: string): Promise<void> {
  const message = ctx.callbackQuery?.message;
  if (message) await ctx.api.editMessageText(message.chat.id, message.message_id, text);
}

export function createBot(token: string, dependencies: BotDependencies): Bot {
  const bot = new Bot(token);
  const albums = new Map<string, { ctx: Context; messages: Message[]; timer: NodeJS.Timeout }>();
  bot.on("message", async (ctx) => {
    const message = ctx.message;
    if (!("text" in message) && !("photo" in message) && !("document" in message && message.document.mime_type?.startsWith("image/"))) return;
    if (dependencies.mediaStore && !dependencies.mediaStore.claimTelegramUpdate(ctx.update.update_id)) return;
    persistMessage(message as StorableMessage, dependencies);
    const media = mediaFromMessage(message);
    if (media?.mediaGroupId) {
      const key = `${message.chat.id}:${media.mediaGroupId}`;
      const existing = albums.get(key);
      if (existing) {
        existing.messages.push(message);
        clearTimeout(existing.timer);
        existing.timer = scheduleAlbum(key, albums, dependencies);
      } else {
        albums.set(key, { ctx, messages: [message], timer: scheduleAlbum(key, albums, dependencies) });
      }
      return;
    }
    await handleIncoming({
      ctx,
      message,
      text: "text" in message ? message.text : "caption" in message ? message.caption ?? "" : "",
      inputs: media ? [media] : [],
    }, dependencies);
  });
  bot.on("edited_message:text", (ctx) => persistMessage(ctx.editedMessage, dependencies));
  bot.on("callback_query:data", (ctx) => {
    if (dependencies.mediaStore && !dependencies.mediaStore.claimTelegramUpdate(ctx.update.update_id)) return;
    return handleCallback(ctx, dependencies);
  });
  bot.catch(({ ctx, error }) => dependencies.logger.error({ err: error, updateId: ctx.update.update_id }, "Unhandled Telegram update error"));
  return bot;
}

function scheduleAlbum(
  key: string,
  albums: Map<string, { ctx: Context; messages: Message[]; timer: NodeJS.Timeout }>,
  dependencies: BotDependencies,
): NodeJS.Timeout {
  const timer = setTimeout(() => {
    const album = albums.get(key);
    albums.delete(key);
    if (!album || album.messages.length === 0) return;
    const ordered = album.messages.sort((a, b) => a.message_id - b.message_id);
    const anchor = ordered.find((message) => "caption" in message && Boolean(message.caption)) ?? ordered[0];
    if (!anchor) return;
    const inputs = ordered.map((message, position) => mediaFromMessage(message, position)).filter((value): value is MediaInput => value !== null);
    const text = "caption" in anchor ? anchor.caption ?? "" : "";
    void handleIncoming({ ctx: album.ctx, message: anchor, text, inputs }, dependencies);
  }, 800);
  timer.unref();
  return timer;
}
