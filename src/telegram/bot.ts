import { Bot, InlineKeyboard, InputFile, type Context, type Filter } from "grammy";
import type { Message, User } from "grammy/types";
import type { Logger } from "pino";

import type { APIMasterClient } from "../clients/apimaster.js";
import type { ActivationService } from "../activation/service.js";
import { ChatCompletionError, ResolverError } from "../clients/apimaster.js";
import {
  APIMASTER_TELEGRAM_BIND_EXISTING_URL,
  APIMASTER_TELEGRAM_LOGIN_URL,
  DEFAULT_MODELS,
} from "../constants.js";
import type { ChatCredential, ChatCredentialProvider } from "../credentials/chat.js";
import { buildConversationMessages, loadConversationContext, type ConversationContext } from "../context/conversation.js";
import type { ContextCompactor } from "../context/compactor.js";
import type { GroupContextCompactor } from "../context/group-compactor.js";
import type { GroupSummaryService } from "../context/group-summary.js";
import { debugContextLayers } from "../debug/context.js";
import type { DebugRecorder } from "../debug/recorder.js";
import type { DebugContextLayers, DebugRequestKind } from "../debug/types.js";
import { FollowUpCoordinator } from "../follow-up/coordinator.js";
import { isMiaIntroductionRequest, miaIntroduction, resolveIntroductionLocale } from "../identity.js";
import {
  mediaIntentSchema,
  type IntentRouter,
  type RoutedIntent,
  type RouterContextMessage,
  type RouterMediaCandidate,
} from "../intent/router.js";
import { MediaInputError, downloadConversationImages, downloadTelegramImages } from "../media/intake.js";
import type { MediaStore } from "../media/store.js";
import type { MediaInput, MediaJob, PendingMediaIntent } from "../media/types.js";
import {
  ONBOARDING_ROLES,
  onboardingCopy,
  onboardingMissingPrompt,
  onboardingRoleLabel,
  type OnboardingRoleId,
} from "../onboarding/localization.js";
import { onboardingMissingFields, type OnboardingEligibility, type OnboardingService } from "../onboarding/service.js";
import { sameModelId, type ModelSettingsService, type SettingsSnapshot } from "../settings/service.js";
import type { ModelOption } from "../settings/types.js";
import type { ContextStore } from "../storage/store.js";
import type {
  ConversationScope,
  GroupConversationScope,
  GroupFollowUpState,
  TranslationLanguagePreference,
  TranslationSession,
} from "../storage/types.js";
import { promptReference, promptText } from "../prompts.js";
import { richMessagePlainText } from "../presentation/rich-message-text.js";
import { miaResponseFromText, miaResponsePlainText, type MiaResponse } from "../presentation/schema.js";
import { renderTelegramRich, type TelegramRichPresentationChunk } from "../presentation/telegram-rich.js";
import { stickerPrompt, stickerSetTitle } from "../stickers/service.js";
import { botText, mediaJobLocale, resolveBotLocale, type BotLocale } from "./localization.js";
import {
  TRANSLATION_PICKER_LANGUAGES,
  canonicalTranslationLanguage,
  defaultTranslationPair,
  translationLanguageLabel,
  type TranslationLanguage,
} from "./translation-languages.js";
import { groupSummaryPresentation } from "./group-summary-html.js";
import {
  miaIntroductionActionPrompt,
  miaIntroductionPanel,
  miaSettingsLaunch,
  type MiaIntroductionAction,
} from "./introduction-panel.js";
import { userFacingError } from "./messages.js";
import type { AgentService } from "../agent/service.js";
import { promptFromMessage, shouldRespond } from "./policy.js";
import { sendTelegramRichText } from "./send-rich-text.js";

type TextContext = Filter<Context, "message:text">;
type StorableMessage = Message.TextMessage | Message.PhotoMessage | Message.DocumentMessage |
  Message.StickerMessage | Message.RichMessageMessage;

interface BotDependencies {
  agent?: AgentService;
  client: APIMasterClient;
  chatCredentials?: ChatCredentialProvider;
  logger: Logger;
  settings: Pick<ModelSettingsService, "getPreferences"> & Partial<Pick<ModelSettingsService, "getDefaults" | "getSnapshot">>;
  contexts: Pick<ContextStore, "upsertUser" | "upsertChat" | "upsertMember" | "saveMessage"> &
    Partial<Pick<ContextStore,
      "listRecentMessages" | "getLatestSummary" | "clearConversation" | "listMemories" |
      "listMessagesAfter" | "getMessage" | "getReplyChain" | "getUser" | "listPendingCompletedTurns" |
      "wakeGroupFollowUp" | "getActiveGroupFollowUp" | "claimGroupFollowUpEvaluation" |
      "markGroupFollowUpHandled" | "expireGroupFollowUp" |
      "markMessageAsTranslation" |
      "enterTranslationSession" | "getActiveTranslationSession" | "touchTranslationSession" |
      "getTranslationLanguagePreference" | "setTranslationLanguagePair" | "exitTranslationSession">>;
  compactor?: ContextCompactor;
  groupCompactor?: GroupContextCompactor;
  groupSummary?: GroupSummaryService;
  router?: IntentRouter;
  mediaStore?: MediaStore;
  botToken?: string;
  resultMaxBytes?: number;
  debug?: DebugRecorder;
  onboarding?: OnboardingService;
  followUpCredential?: Pick<ChatCredential, "apiKey" | "model">;
  miniAppUrl?: string | null;
  activation?: ActivationService;
}

const TRANSLATION_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["source", "translated_text"],
  properties: {
    source: { type: "string", enum: ["left_language", "right_language"] },
    translated_text: { type: "string", minLength: 1, maxLength: 20_000 },
  },
} as const;

interface IncomingMessage {
  ctx: Context;
  message: Message;
  text: string;
  inputs: MediaInput[];
}

interface IncomingRequest extends IncomingMessage {
  triggerMode?: "direct" | "active_follow_up";
  batch?: readonly IncomingMessage[];
  followUpState?: GroupFollowUpState;
  onIntervention?: () => void;
}

type ContextReader = Pick<ContextStore,
  "getLatestSummary" | "listMemories" | "listMessagesAfter" | "listRecentMessages" |
  "getMessage" | "getReplyChain" | "getUser" | "listPendingCompletedTurns">;

type FollowUpStore = Pick<ContextStore,
  "wakeGroupFollowUp" | "getActiveGroupFollowUp" | "claimGroupFollowUpEvaluation" |
  "markGroupFollowUpHandled" | "expireGroupFollowUp">;

type TranslationStore = Pick<ContextStore,
  "enterTranslationSession" | "getActiveTranslationSession" | "touchTranslationSession" |
  "getTranslationLanguagePreference" | "setTranslationLanguagePair" | "exitTranslationSession">;

function followUpStore(dependencies: BotDependencies): FollowUpStore | null {
  const store = dependencies.contexts as Partial<FollowUpStore>;
  return store.wakeGroupFollowUp && store.getActiveGroupFollowUp && store.claimGroupFollowUpEvaluation &&
    store.markGroupFollowUpHandled && store.expireGroupFollowUp ? store as FollowUpStore : null;
}

function translationStore(dependencies: BotDependencies): TranslationStore | null {
  const store = dependencies.contexts as Partial<TranslationStore>;
  return store.enterTranslationSession && store.getActiveTranslationSession && store.touchTranslationSession &&
    store.getTranslationLanguagePreference && store.setTranslationLanguagePair && store.exitTranslationSession
    ? store as TranslationStore
    : null;
}

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

function messageText(message: Message | undefined): string | null {
  if (!message) return null;
  if ("text" in message) return message.text;
  if ("caption" in message) return message.caption ?? null;
  if ("rich_message" in message) return richMessagePlainText(message.rich_message.blocks);
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
  const contentType = media?.type ?? ("sticker" in message ? "sticker" : "rich_message" in message
    ? "rich_message" : "document" in message ? "document" : "text");
  const richText = "rich_message" in message ? richMessagePlainText(message.rich_message.blocks) : null;
  contexts.saveMessage({
    chatId: message.chat.id,
    messageId: message.message_id,
    threadId: message.message_thread_id ?? null,
    senderUserId: from?.id ?? null,
    senderChatId: message.sender_chat?.id ?? null,
    replyToMessageId: message.reply_to_message?.message_id ?? null,
    contentType,
    text: "text" in message ? message.text : richText,
    caption: "caption" in message ? message.caption ?? null : null,
    entitiesJson: "entities" in message && message.entities ? JSON.stringify(message.entities) :
      "caption_entities" in message && message.caption_entities ? JSON.stringify(message.caption_entities) :
        "rich_message" in message ? JSON.stringify(message.rich_message.blocks) : null,
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

function routerContextMessages(context: ConversationContext, botUserId: number): RouterContextMessage[] {
  return context.messages.map((message) => ({
    role: message.senderUserId === botUserId ? "assistant" : "user",
    text: message.text ?? message.caption ?? `[${message.contentType}]`,
    messageId: message.messageId,
    senderUserId: message.senderUserId,
    replyToMessageId: message.replyToMessageId,
    contentType: message.contentType,
    sentAt: message.sentAt,
  }));
}

function routerMediaCandidates(context: ConversationContext, userId: number): RouterMediaCandidate[] {
  const messages = new Map(context.messages.map((message) => [message.messageId, message]));
  return context.mediaInputs.flatMap((input) => {
    const message = messages.get(input.messageId);
    if (!message) return [];
    const source: RouterMediaCandidate["source"] = input.messageId === context.currentMessageId ? "current"
      : input.messageId === context.replyToMessageId ? "reply"
        : input.messageId === context.activeMediaMessageId ? "active_private_image"
          : message.senderUserId === userId ? "current_user_recent" : "topic_recent";
    return [{
      messageId: input.messageId,
      senderUserId: message.senderUserId,
      type: input.type,
      sentAt: message.sentAt,
      source,
    }];
  });
}

function resolveSelectedMedia(
  message: Message,
  selectedMessageIds: readonly number[],
  candidates: readonly RouterMediaCandidate[],
  mediaStore: MediaStore,
): MediaInput[] {
  const allowed = new Set(candidates.map((candidate) => candidate.messageId));
  const threadId = message.message_thread_id ?? null;
  const selected: MediaInput[] = [];
  const seen = new Set<string>();
  for (const messageId of selectedMessageIds) {
    if (!allowed.has(messageId)) continue;
    for (const input of mediaStore.getTelegramMedia(message.chat.id, messageId)) {
      if (input.threadId !== threadId || seen.has(input.fileId)) continue;
      seen.add(input.fileId);
      selected.push(input);
      if (selected.length === 10) return normalizePositions(selected);
    }
  }
  return normalizePositions(selected);
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

async function handleTranslationMessage(
  ctx: Context,
  message: Message,
  text: string,
  session: TranslationSession,
  dependencies: BotDependencies,
): Promise<void> {
  if (!message.from || message.chat.type !== "private") return;
  const locale = resolveBotLocale(message.from.language_code);
  dependencies.contexts.markMessageAsTranslation?.(message.chat.id, message.message_id);
  try {
    await ctx.api.sendChatAction(message.chat.id, "typing");
    const selectedModel = dependencies.settings.getPreferences(message.from.id).chatModel ?? DEFAULT_MODELS.chat;
    const credential = await resolveTextCredential(dependencies, message.from.id, selectedModel, DEFAULT_MODELS.chat);
    const result = await dependencies.client.structuredResponse(
      credential.apiKey,
      credential.model,
      [
        { role: "system", content: promptText("mia.translation-mode", locale) },
        { role: "user", content: JSON.stringify({
          source_text: text,
          language_pair: { left_language: session.leftLanguage, right_language: session.rightLanguage },
          instruction: "Identify which side source_text belongs to and translate it into the other language. Return only the structured result.",
        }) },
      ],
      "mia_translation",
      TRANSLATION_RESULT_SCHEMA,
      Math.min(credential.model === "gpt-5.4" ? 30_000 : 45_000, 45_000),
      { webSearch: false },
    );
    const value = result.data as { source?: unknown; translated_text?: unknown };
    if ((value.source !== "left_language" && value.source !== "right_language") ||
        typeof value.translated_text !== "string" || !value.translated_text.trim()) {
      throw new Error("invalid_translation_result");
    }
    const sent = await replyPlainTo(ctx, message, value.translated_text, {
      reply_markup: translationStatusKeyboard(
        message.from.id,
        locale,
        value.translated_text,
      ),
    });
    persistMessage(sent, dependencies);
    dependencies.contexts.markMessageAsTranslation?.(sent.chat.id, sent.message_id);
    translationStore(dependencies)?.touchTranslationSession(message.from.id, message.chat.id);
  } catch (error) {
    dependencies.logger.warn({ err: error, telegramUserId: message.from.id }, "Telegram translation request failed");
    await replyTo(ctx, message, userFacingError(error, selectedModelForError(dependencies, message.from.id), locale));
  }
}

function selectedModelForError(dependencies: BotDependencies, telegramUserId: number): string {
  return dependencies.settings.getPreferences(telegramUserId).chatModel ?? DEFAULT_MODELS.chat;
}

async function handleIncoming(request: IncomingRequest, dependencies: BotDependencies): Promise<void> {
  let { ctx, message } = request;
  if (!message.from || !ctx.me || !dependencies.mediaStore) return;
  if (message.chat.type === "private" && dependencies.activation) {
    const text = request.text.trim();
    if (!/^\/start(?:\s|$)/u.test(text)) {
      if (/^(?:停止|不要提醒|不再提醒|stop|unsubscribe)$/iu.test(text)) {
        dependencies.activation.dismiss(message.from.id, true);
        await ctx.reply(resolveBotLocale(message.from.language_code) === "zh-CN" ? "已关闭 Mia 的主动提醒。" : "Mia reminders are turned off.");
        return;
      }
      if (dependencies.activation.consumeWeatherIntent(message.from.id, message.chat.id)) {
        dependencies.activation.markInteraction(message.from.id);
        try {
          const weather = await dependencies.activation.requestWeather(message.from.id, message.chat.id, text);
          const locale = resolveBotLocale(message.from.language_code);
          if (!weather) {
            await ctx.reply(locale === "zh-CN" ? "没有找到这个城市。请再发一次城市名，例如“上海”或“Paris, France”。" : "I couldn't find that city. Try again, for example Shanghai or Paris, France.");
          } else if ("choices" in weather) {
            await ctx.reply(locale === "zh-CN" ? `这个城市可能有多个地点，请加上国家或地区：${weather.choices.join("；")}` : `There are several matches. Please add a country or region: ${weather.choices.join("; ")}`);
          } else {
            const reply = await dependencies.activation.weatherTextForRequest(message.from.id, message.from.language_code);
            if (reply) await ctx.reply(reply, { reply_markup: dependencies.activation.weatherSubscriptionKeyboard(message.from.language_code) });
          }
        } catch (error) {
          dependencies.logger.warn({ err: error, telegramUserId: message.from.id }, "Mia weather request failed");
          await ctx.reply(resolveBotLocale(message.from.language_code) === "zh-CN" ? "这次天气查询失败了，请稍后再试。" : "The weather lookup failed this time. Please try again shortly.");
        }
        return;
      }
      dependencies.activation.markInteraction(message.from.id);
    }
  }
  const automaticFollowUp = request.triggerMode === "active_follow_up";
  let locale = resolveBotLocale(message.from.language_code);
  const entities = "entities" in message ? message.entities : "caption_entities" in message ? message.caption_entities : undefined;
  const policyInput = {
    chatType: message.chat.type,
    text: request.text,
    entities,
    repliedToUserId: message.reply_to_message?.from?.id,
  };
  const identity = { id: ctx.me.id, username: ctx.me.username };
  const explicit = parseExplicitCommand(request.text);
  const explicitSummaryPhrase = isExplicitGroupSummaryPhrase(promptFromMessage(policyInput, identity));
  const namedMediaReply = message.reply_to_message !== undefined && /^(?:@?mia)(?:\s|[,，:：])/i.test(request.text.trim());
  const repliedMessageText = messageText(message.reply_to_message);
  const pending = dependencies.mediaStore.getPendingIntent?.(scopeFor(message)) ?? null;
  const suppliesPendingMedia = pending !== null && request.inputs.length > 0;
  if (!automaticFollowUp && !shouldRespond(policyInput, identity) && !explicit && !namedMediaReply &&
      !explicitSummaryPhrase && !suppliesPendingMedia) return;

  const startPayload = message.chat.type === "private" ? parseStartPayload(request.text) : null;
  if (startPayload !== null && typeof startPayload === "object" && startPayload.type === "login") {
    await handleTelegramDeepLinkLogin(ctx, message, startPayload.code, dependencies);
    return;
  }

  const translations = translationStore(dependencies);
  if (message.chat.type === "private" && translations && explicit?.command === "tr") {
    const pair = defaultTranslationLanguages(
      message.from.language_code,
      explicit.instruction,
      translations.getTranslationLanguagePreference(message.from.id),
    );
    const session = translations.enterTranslationSession(message.from.id, message.chat.id, pair.leftLanguage, pair.rightLanguage);
    await replyPlainTo(ctx, message, translationStatusText(session, locale), {
      reply_markup: translationStatusKeyboard(message.from.id, locale),
    });
    return;
  }
  if (message.chat.type === "private" && translations && explicit?.command === "ntr") {
    translations.exitTranslationSession(message.from.id, message.chat.id);
    await replyTo(ctx, message, botText(locale, "translationModeDisabled"));
    return;
  }
  if (message.chat.type !== "private" && (explicit?.command === "tr" || explicit?.command === "ntr")) {
    await replyTo(ctx, message, botText(locale, "translationPrivateOnly"));
    return;
  }
  if (message.chat.type === "private" && translations) {
    const activeTranslation = getNormalizedTranslationSession(translations, message.from.id, message.chat.id);
    if (activeTranslation && explicit?.command === "new") translations.exitTranslationSession(message.from.id, message.chat.id);
    else if (activeTranslation && explicit) {
      await replyTo(ctx, message, botText(locale, "translationExitButton"));
      return;
    } else if (activeTranslation && request.text.trim()) {
      await handleTranslationMessage(ctx, message, request.text.trim(), activeTranslation, dependencies);
      return;
    }
  }

  if (startPayload === "settings") {
    const launch = miaSettingsLaunch(locale, miniAppUrl(dependencies));
    const sent = await replyTo(ctx, message, launch.text, { reply_markup: launch.keyboard });
    persistMessage(sent, dependencies);
    return;
  }
  if (startPayload === "sticker") {
    await sendIntroductionActionPrompt(ctx, message, message.from, "sticker", dependencies);
    return;
  }

  const requestedIntroduction = promptFromMessage(policyInput, identity);
  if (!automaticFollowUp && isMiaIntroductionRequest(requestedIntroduction)) {
    const introductionLocale = resolveIntroductionLocale(requestedIntroduction, locale);
    const introduction = miaIntroduction(introductionLocale);
    const panel = miaIntroductionPanel(introductionLocale, ctx.me.username, {
      privateChat: message.chat.type === "private",
      miniAppUrl: miniAppUrl(dependencies),
    });
    let assistantMessageId: number | null = null;
    try {
      const sent = await ctx.api.sendPhoto(message.chat.id, introductionImageUrl(dependencies), {
        ...replyOptions(message),
        caption: miaResponsePlainText(introduction),
        reply_markup: panel,
      });
      assistantMessageId = persistContextOnly(sent, dependencies) ? sent.message_id : null;
    } catch (error) {
      dependencies.logger.warn({ err: error }, "Mia introduction image could not be sent; using text fallback");
      const delivery = await sendConversationResponse(
        ctx,
        message,
        introduction,
        dependencies,
        { reply_markup: panel },
      );
      assistantMessageId = delivery.assistantMessageId;
    }
    if (assistantMessageId !== null) recordSuccessfulGroupTrigger(message, dependencies);
    request.onIntervention?.();
    return;
  }

  if (explicit?.command === "media_on" || explicit?.command === "media_off") {
    await handleMediaAdmin(ctx, explicit.command === "media_on", dependencies.mediaStore);
    return;
  }
  if (explicit?.command === "new" || explicit?.command === "forget") {
    if (message.chat.type !== "private") {
      const member = await ctx.api.getChatMember(message.chat.id, message.from.id);
      if (member.status !== "creator" && member.status !== "administrator") {
        await replyTo(ctx, message, botText(locale, "adminOnly"));
        return;
      }
    }
    dependencies.mediaStore.clearPendingIntent(scopeFor(message));
    dependencies.agent?.cancel({ userId: message.from.id, chatId: message.chat.id, threadId: message.message_thread_id ?? null });
    if (message.chat.type === "private") translations?.exitTranslationSession(message.from.id, message.chat.id);
    if (message.chat.type === "private") dependencies.mediaStore.clearActivePrivateImage(message.from.id, message.chat.id);
    dependencies.contexts.clearConversation?.(conversationScope(message));
    await replyTo(ctx, message, botText(locale, "contextCleared"));
    return;
  }
  const directSummary = explicit?.command === "summary" || explicitSummaryPhrase;
  if (directSummary && !dependencies.agent?.enabled(message.from.id)) {
    await handleGroupSummary(ctx, message, dependencies, locale);
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
  const stickerContinuation = pending?.intent === "sticker_create" ||
    pending?.missingRequired.includes("sticker_output") === true;
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
  let inputs = normalizePositions(chosenInputs);
  if (!automaticFollowUp && dependencies.agent?.enabled(message.from.id) &&
      (!explicit || ["image", "video", "vision", "sticker", "summary"].includes(explicit.command))) {
    dependencies.agent.enqueue({
      key: `${message.chat.id}:${message.message_id}`, userId: message.from.id,
      chatId: message.chat.id, threadId: message.message_thread_id ?? null,
      messageId: message.message_id, replyToMessageId: message.reply_to_message?.message_id ?? null,
      language: message.from.language_code ?? "en", text: promptFromMessage(policyInput, identity), media: inputs,
    });
    request.onIntervention?.();
    return;
  }
  const callbackReply = pending?.missingRequired.includes("callback_reply") === true &&
    pending.sourceMessageIds.at(-1) === message.reply_to_message?.message_id;
  const savedCallbackIntent = callbackReply ? mediaIntentSchema.safeParse(pending.slots) : null;

  if (!automaticFollowUp && request.inputs.length > 0 && await rejectUnavailableMediaUser(ctx, message, dependencies)) {
    return;
  }

  if (request.inputs.length > 0 && request.text.trim() === "" && !pending) {
    if (message.chat.type !== "private" && !dependencies.mediaStore.isGroupMediaEnabled(message.chat.id)) {
      await replyTo(ctx, message, botText(locale, "mediaDisabled"));
      return;
    }
    await replyTo(ctx, message, botText(locale, "imageActionQuestion"), {
      reply_markup: imageActionKeyboard(message.from.id, message.message_id, locale),
    });
    return;
  }

  let routed: RoutedIntent;
  let routerDebugId: string | null = null;
  let routerCredential: ChatCredential | null = null;
  let onboardingEligibility: OnboardingEligibility | null = null;
  let followUpTypingSent = false;
  if (savedCallbackIntent?.success) {
    const callbackInstruction = request.text.trim() ||
      (stickerContinuation ? savedCallbackIntent.data.instruction : "");
    routed = {
      ...savedCallbackIntent.data,
      intent: stickerContinuation ? "sticker_create" : savedCallbackIntent.data.intent,
      instruction: callbackInstruction,
      missingRequired: callbackInstruction ? [] : ["instruction"],
    };
  } else if (explicit?.command === "image") {
    const image = parseImageOptions(explicit.instruction);
    routed = {
      ...directIntent(inputs.length > 0 ? "image_edit" : "image_generate", image.instruction, inputs.length > 0 ? "message" : "none"),
      image_options: { aspect_ratio: image.aspectRatio },
    };
  } else if (explicit?.command === "sticker") {
    routed = {
      ...directIntent("sticker_create", explicit.instruction, inputs.length > 0 ? "message" : "none"),
      missingRequired: inputs.length > 0 ? [] : ["image"],
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
    const recent = dependencies.contexts.listRecentMessages?.(scope, 20) ?? [];
    const summary = dependencies.contexts.getLatestSummary?.(scope)?.content ?? null;
    onboardingEligibility = message.chat.type === "private" && dependencies.onboarding
      ? dependencies.onboarding.eligibility(message.chat.id, message.from.id)
      : null;
    let debugId: string | null = null;
    try {
      if (!automaticFollowUp) {
        await ctx.api.sendChatAction(message.chat.id, "typing", threadOption(message));
      }
      routerCredential = automaticFollowUp && dependencies.followUpCredential
        ? { ...dependencies.followUpCredential, source: "guest", fallbackReason: null }
        : await resolveTextCredential(dependencies, message.from.id, dependencies.router.model);
      const requestContext = await buildRequestContext(
        ctx,
        message,
        dependencies,
        activeInputs[0] ?? null,
        pending?.intent ?? null,
        !automaticFollowUp && routerCredential.source === "user" ? new Set(inputs.map((input) => input.messageId)) : false,
      );
      const fallbackImages = routerCredential.source === "user" && requestContext === null && inputs.length > 0
        ? await downloadTelegramImages(ctx.api, dependencies.botToken ?? "", inputs)
        : [];
      const mediaCandidates = requestContext ? routerMediaCandidates(requestContext.context, message.from.id) : [];
      debugId = dependencies.debug?.start({
        telegramUserId: message.from.id,
        chatId: message.chat.id,
        chatType: message.chat.type,
        messageId: message.message_id,
        kind: "intent_router",
        model: routerCredential.model,
        promptRefs: automaticFollowUp
          ? [promptReference("mia.follow-up-participation"), promptReference("mia.follow-up-chat")]
          : [promptReference("mia.intent-router")],
        contextLayers: requestContext?.layers ?? null,
        requestPreview: {
          currentRequestText: promptFromMessage(policyInput, identity),
          repliedMessageText,
          replyToMessageId: message.reply_to_message?.message_id ?? null,
        },
        media: mediaCandidates.map((candidate) => ({
          messageId: candidate.messageId,
          senderUserId: candidate.senderUserId,
          type: candidate.type,
          source: candidate.source,
          pixelsProvided: requestContext?.includedMediaMessageIds.includes(candidate.messageId) ?? false,
        })),
        details: {
          phase: "intent_and_response",
          triggerMode: request.triggerMode ?? "direct",
          followUpBatchMessageIds: request.batch?.map((item) => item.message.message_id) ?? [],
          followUpScope: request.followUpState?.scope ?? null,
          rateLimitOutcome: automaticFollowUp ? "claimed" : "not_applicable",
          credentialSource: routerCredential.source,
          credentialPurpose: automaticFollowUp ? "public_follow_up" : "requester",
          credentialFallbackReason: routerCredential.fallbackReason,
          onboarding: onboardingEligibility ? {
            serverEligible: onboardingEligibility.eligible,
            completedTurns: onboardingEligibility.completedTurns,
            currentTurn: onboardingEligibility.currentTurn,
            promptCount: onboardingEligibility.promptCount,
            missingFields: onboardingEligibility.missingFields,
            eligibilityReason: onboardingEligibility.reason,
          } : { serverEligible: false, eligibilityReason: "not_private_or_unavailable" },
        },
      }) ?? null;
      routerDebugId = debugId;
      routed = await dependencies.router.classify({
        text: promptFromMessage(policyInput, identity),
        locale: message.from.language_code ?? null,
        participationMode: automaticFollowUp ? "selective" : "required",
        followUpBatchMessageIds: request.batch?.map((item) => item.message.message_id) ?? [],
        followUpContext: request.followUpState ? {
          scopeType: request.followUpState.scope.type,
          chatId: request.followUpState.scope.chatId,
          threadId: request.followUpState.scope.type === "topic" ? request.followUpState.scope.threadId : null,
          awakenedByUserId: request.followUpState.awakenedByUserId,
          lastHandledAt: request.followUpState.lastHandledAt,
        } : null,
        mediaType: inputs.length > 0 ? "image" : "none",
        mediaCount: request.inputs.length,
        replyMediaCount: replyInputs.length,
        replyToMessageId: message.reply_to_message?.message_id ?? null,
        repliedMessageText,
        activePrivateImage: active !== null,
        allowGroupSummary: message.chat.type !== "private",
        summary,
        recentMessages: requestContext ? routerContextMessages(requestContext.context, ctx.me.id) : recent.map((item) => ({
          role: item.senderUserId === ctx.me.id ? "assistant" as const : "user" as const,
          text: item.text ?? item.caption ?? `[${item.contentType}]`,
          messageId: item.messageId,
          senderUserId: item.senderUserId,
          replyToMessageId: item.replyToMessageId,
          contentType: item.contentType,
          sentAt: item.sentAt,
        })),
        mediaCandidates,
        mediaPixelsProvided: Boolean(requestContext?.includedMediaMessageIds.length || fallbackImages.length),
        ...(requestContext ? { conversationMessages: requestContext.messages } : {}),
        onboarding: {
          active: Boolean(onboardingEligibility?.eligible || onboardingEligibility?.promptCount),
          missingFields: onboardingEligibility?.missingFields ?? [],
        },
        ...(automaticFollowUp ? {
          onParticipationDecision: async (responseToMessageId: number) => {
            const target = request.batch?.find((item) => item.message.message_id === responseToMessageId);
            if (!target) return;
            await target.ctx.api.sendChatAction(
              target.message.chat.id,
              "typing",
              threadOption(target.message),
            );
            followUpTypingSent = true;
          },
        } : {}),
      }, routerCredential.apiKey, fallbackImages, routerCredential.model);
      if (inputs.length === 0 && (routed.media_message_ids?.length ?? 0) > 0) {
        inputs = resolveSelectedMedia(message, routed.media_message_ids ?? [], mediaCandidates, dependencies.mediaStore);
      }
      const kind: DebugRequestKind = routed.intent === "chat" ? "chat" : routed.intent === "vision_qa" ? "vision_qa" : "intent_router";
      const routingFailed = routed.fallbackReason === "router_unavailable" || routed.fallbackReason === "invalid_output";
      dependencies.debug?.finish(debugId, {
        status: routingFailed ? "failed" : "succeeded",
        errorCode: routingFailed ? (routed.fallbackReason ?? "routing_failed") : null,
        responsePreview: routed,
        details: {
          phase: "intent_and_response",
          triggerMode: request.triggerMode ?? "direct",
          shouldRespond: routed.should_respond,
          responseToMessageId: routed.response_to_message_id,
          routedIntent: routed.intent,
          selectedMediaMessageIds: routed.media_message_ids ?? [],
          fallbackReason: routed.fallbackReason ?? null,
          participationSource: routed.participationSource ?? null,
          participationReason: routed.participationReason ?? null,
          webSearch: routed.webSearch ?? { callCount: 0, queries: [], sources: [] },
          onboarding: onboardingDebugDetails(onboardingEligibility, routed, false),
        },
        kind,
      });
    } catch (error) {
      dependencies.debug?.finish(debugId, {
        status: "failed",
        errorCode: debugErrorCode(error),
      });
      if (!automaticFollowUp) {
        await replyTo(ctx, message, error instanceof MediaInputError
          ? mediaError(error, locale)
          : userFacingError(error, dependencies.router.model, locale));
      }
      return;
    }
    if (routed.should_respond === false) return;
    if (pending && routed.intent === "chat") {
      const saved = mediaIntentSchema.safeParse(pending.slots);
      if (saved.success) {
        routed = {
          ...saved.data,
          intent: stickerContinuation ? "sticker_create" : saved.data.intent,
          instruction: pending.missingRequired.some((field) => field === "instruction" || field === "question")
            ? request.text.trim()
            : saved.data.instruction,
          missingRequired: [],
        };
      }
    }
  }

  if (routed.should_respond === false) return;
  if (automaticFollowUp) {
    const target = request.batch?.find((item) => item.message.message_id === routed.response_to_message_id);
    if (!target?.message.from) return;
    ctx = target.ctx;
    message = target.message;
    locale = resolveBotLocale(target.message.from.language_code);
    if (!followUpTypingSent) await ctx.api.sendChatAction(message.chat.id, "typing", threadOption(message));
  }
  const responseSender = message.from;
  if (!responseSender) return;

  if (routed.intent === "group_summary") {
    await handleGroupSummary(ctx, message, dependencies, locale);
    request.onIntervention?.();
    return;
  }

  if (routed.intent === "sticker_create" && message.chat.type !== "private") {
    await replyTo(ctx, message, botText(locale, "stickerPrivateOnly"));
    request.onIntervention?.();
    return;
  }
  if (routed.intent === "sticker_create" && inputs.length > 1) {
    await replyTo(ctx, message, botText(locale, "stickerSingleImage"));
    request.onIntervention?.();
    return;
  }

  if (!automaticFollowUp && routerCredential?.source === "guest" && isMediaIntent(routed.intent)) {
    await replyMediaAccessError(
      ctx,
      message,
      new ResolverError(routerCredential.fallbackReason ?? "no_usable_api_key"),
      locale,
    );
    request.onIntervention?.();
    return;
  }

  if (routed.intent === "chat") {
    const response = routed.reply ?? routed.final_response;
    if (response) {
      const delivery = await sendConversationResponse(ctx, message, response, dependencies);
      const assistantMessageId = delivery.assistantMessageId;
      recordCompletedChatTurn(message, assistantMessageId, dependencies);
      if (assistantMessageId !== null) recordSuccessfulGroupTrigger(message, dependencies);
      if (assistantMessageId !== null && message.chat.type === "private" && dependencies.onboarding && routed.profile_updates) {
        dependencies.onboarding.applyProfileUpdates(responseSender.id, message.message_id, {
          preferredName: routed.profile_updates.preferred_name,
          primaryRole: routed.profile_updates.primary_role,
          primaryGoal: routed.profile_updates.primary_goal,
        });
      }
      const triggered = assistantMessageId !== null && onboardingEligibility?.eligible === true &&
        routed.conversation_mode === "casual" && routed.onboarding_opportunity &&
        await maybeSendOnboardingPrompt(ctx, message, onboardingEligibility.currentTurn, dependencies);
      dependencies.debug?.finish(routerDebugId, {
        status: "succeeded",
        details: {
          phase: "intent_and_response",
          routedIntent: routed.intent,
          fallbackReason: routed.fallbackReason ?? null,
          webSearch: routed.webSearch ?? { callCount: 0, queries: [], sources: [] },
          onboarding: onboardingDebugDetails(onboardingEligibility, routed, triggered),
          presentation: delivery.presentation,
        },
      });
      if (assistantMessageId !== null) request.onIntervention?.();
    } else {
      await runChat(ctx, promptFromMessage(policyInput, identity), dependencies);
    }
    return;
  }
  if (message.chat.type !== "private" && !dependencies.mediaStore.isGroupMediaEnabled(message.chat.id)) {
    await replyTo(ctx, message, botText(locale, "mediaDisabled"));
    request.onIntervention?.();
    return;
  }
  const visionResponse = routed.reply ?? routed.final_response;
  if (routed.intent === "vision_qa" && visionResponse) {
    const delivery = await sendConversationResponse(ctx, message, visionResponse, dependencies);
    const assistantMessageId = delivery.assistantMessageId;
    dependencies.debug?.finish(routerDebugId, {
      status: "succeeded",
      responsePreview: routed,
      details: {
        phase: "intent_and_response",
        routedIntent: routed.intent,
        fallbackReason: routed.fallbackReason ?? null,
        webSearch: routed.webSearch ?? { callCount: 0, queries: [], sources: [] },
        presentation: delivery.presentation,
      },
    });
    if (assistantMessageId !== null) recordSuccessfulGroupTrigger(message, dependencies);
    if (assistantMessageId !== null) request.onIntervention?.();
    return;
  }

  const missing = [...routed.missingRequired];
  if ((routed.intent === "image_edit" || routed.intent === "sticker_create" || routed.intent === "vision_qa" ||
      routed.intent === "video_generate" && routed.video_options?.mode === "image_to_video") && inputs.length === 0) {
    missing.push("image");
  }
  if (routed.intent !== "sticker_create" && routed.instruction.trim() === "" &&
      !missing.includes("instruction") && !missing.includes("question")) {
    missing.push(routed.intent === "vision_qa" ? "question" : "instruction");
  }
  if (missing.length > 0) {
    dependencies.mediaStore.savePendingIntent({
      ...scopeFor(message),
      intent: routed.intent,
      slots: {
        intent: routed.intent,
        should_respond: routed.should_respond,
        response_to_message_id: routed.response_to_message_id,
        confidence: routed.confidence,
        instruction: routed.instruction,
        media_source: routed.media_source,
        media_message_ids: routed.media_message_ids ?? [],
        image_options: routed.image_options,
        video_options: routed.video_options,
        reply: routed.reply,
        final_response: routed.final_response,
        conversation_mode: routed.conversation_mode,
        onboarding_opportunity: routed.onboarding_opportunity,
        profile_updates: routed.profile_updates,
      },
      missingRequired: [...new Set(missing)],
      sourceMessageIds: [message.message_id, ...inputs.map((input) => input.messageId)],
    });
    await replyTo(ctx, message, clarification(missing[0] ?? "instruction", locale));
    request.onIntervention?.();
    return;
  }
  dependencies.mediaStore.clearPendingIntent(scopeFor(message));
  const handled = await executeMediaIntent(ctx, message, routed, inputs, dependencies, stickerContinuation);
  if (handled) request.onIntervention?.();
}

async function executeMediaIntent(
  ctx: Context,
  message: Message,
  routed: RoutedIntent,
  inputs: MediaInput[],
  dependencies: BotDependencies,
  legacyStickerContinuation = false,
): Promise<boolean> {
  if (!message.from || !dependencies.mediaStore || !dependencies.botToken) return false;
  const locale = resolveBotLocale(message.from.language_code);
  let debugId: string | null = null;
  let handled = false;
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
      handled = true;
    }
    if (routed.intent === "vision_qa") {
      const model = snapshot?.settings.visionModel;
      if (!model) {
        await replyTo(ctx, message, botText(locale, "noVisionModel"));
        return true;
      }
      await ctx.api.sendChatAction(message.chat.id, "typing", threadOption(message));
      const apiKey = await dependencies.client.resolveAPIKey(message.from.id, model);
      const activeMedia = inputs.find((input) => input.messageId !== message.message_id &&
        input.messageId !== message.reply_to_message?.message_id) ?? null;
      const requestContext = await buildRequestContext(
        ctx,
        message,
        dependencies,
        activeMedia,
        "vision_qa",
        new Set(inputs.map((input) => input.messageId)),
      );
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
          { role: "system", content: promptText("mia.system", locale) },
          ...requestContext.messages,
        ])
        : await dependencies.client.vision(
          apiKey,
          model,
          routed.instruction,
          await downloadTelegramImages(ctx.api, dependencies.botToken, inputs),
          [],
          locale,
        );
      const delivery = await sendConversationResponse(ctx, message, response, dependencies);
      const assistantMessageId = delivery.assistantMessageId;
      dependencies.debug?.finish(debugId, {
        status: "succeeded",
        responsePreview: response,
        details: { presentation: delivery.presentation },
      });
      if (assistantMessageId !== null) recordSuccessfulGroupTrigger(message, dependencies);
      return assistantMessageId !== null || handled;
    }
    if (routed.intent === "video_generate") {
      const model = snapshot?.settings.videoModel ??
        dependencies.settings.getPreferences(message.from.id).videoModel ?? DEFAULT_MODELS.video;
      await dependencies.client.resolveAPIKey(message.from.id, model);
      return await createVideoDraft(ctx, message, routed, inputs, snapshot, dependencies) || handled;
    }
    if (routed.intent !== "image_generate" && routed.intent !== "image_edit" && routed.intent !== "sticker_create") return handled;
    const stickerOutput = routed.intent === "sticker_create" || legacyStickerContinuation;
    const model = snapshot?.settings.imageModel ?? dependencies.settings.getPreferences(message.from.id).imageModel ?? DEFAULT_MODELS.image;
    await dependencies.client.resolveAPIKey(message.from.id, model);
    if (dependencies.mediaStore.getJobByIdempotencyKey(requestKey(message))) return handled;
    const status = await replyPlainTo(ctx, message, botText(locale, "stillProcessing", { progress: "" }));
    handled = true;
    const claim = dependencies.mediaStore.claimJob({
      ...scopeFor(message),
      type: routed.intent === "sticker_create" ? "image_edit" : routed.intent,
      idempotencyKey: requestKey(message),
      requestMessageId: message.message_id,
      statusMessageId: status.message_id,
      model,
      instruction: stickerOutput ? stickerPrompt(routed.instruction) : routed.instruction,
      options: {
        aspectRatio: routed.image_options?.aspect_ratio ?? "1:1",
        locale,
        ...(stickerOutput ? {
          outputMode: "telegram_sticker",
          stickerTitle: stickerSetTitle(message.from.first_name),
        } : {}),
      },
    }, inputs);
    if (claim.outcome === "limit_reached") {
      await ctx.api.editMessageText(message.chat.id, status.message_id, botText(locale, "activeLimit"));
    } else if (claim.outcome === "existing") {
      await ctx.api.editMessageText(message.chat.id, status.message_id, botText(locale, "requestAlready", {
        status: claim.job.status,
      }));
    }
    return handled;
  } catch (error) {
    dependencies.debug?.finish(debugId, { status: "failed", errorCode: debugErrorCode(error) });
    await replyMediaAccessError(ctx, message, error, locale);
    return true;
  }
}

async function createVideoDraft(
  ctx: Context,
  message: Message,
  routed: RoutedIntent,
  inputs: MediaInput[],
  snapshot: SettingsSnapshot | null,
  dependencies: BotDependencies,
): Promise<boolean> {
  if (!message.from || !dependencies.mediaStore) return false;
  const locale = resolveBotLocale(message.from.language_code);
  const model = snapshot?.settings.videoModel ?? dependencies.settings.getPreferences(message.from.id).videoModel ?? DEFAULT_MODELS.video;
  const modelOption = snapshot?.models.find((item) => sameModelId(item.id, model));
  const caps = modelOption?.videoCapabilities;
  if (!caps || !hasCompleteVideoCapabilities(modelOption)) {
    await replyTo(ctx, message, botText(locale, "videoMetadataMissing"));
    return true;
  }
  const duration = routed.video_options?.duration_seconds ?? caps.durationSeconds.default;
  const ratio = routed.video_options?.aspect_ratio ?? caps.defaultAspectRatio;
  const resolution = resolveVideoResolution(caps, routed.video_options?.resolution ?? null);
  if (resolution === null || duration < caps.durationSeconds.min || duration > caps.durationSeconds.max ||
      !caps.aspectRatios.includes(ratio) || inputs.length > caps.maxReferenceImages) {
    await replyTo(ctx, message, botText(locale, "unsupportedVideo"));
    return true;
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
      resolutionSource: resolution === undefined ? "channel_default" : "user",
      mode: inputs.length > 0 ? "image_to_video" : "text_to_video",
      locale,
    },
  }, inputs);
  if (draft.status !== "draft" || draft.statusMessageId !== null) return false;
  const sent = await replyPlainTo(ctx, message, videoDraftText(draft), { reply_markup: draftKeyboard(draft) });
  dependencies.mediaStore.updateDraft(draft.id, draft.options, sent.message_id);
  return true;
}

function hasCompleteVideoCapabilities(model: ModelOption | undefined): model is ModelOption & {
  videoCapabilities: NonNullable<ModelOption["videoCapabilities"]>;
} {
  const caps = model?.videoCapabilities;
  return Boolean(
    caps &&
    (caps.defaultResolution === "" ||
      caps.resolutions.some((value) => value.toLowerCase() === caps.defaultResolution.toLowerCase())) &&
    caps.aspectRatios.length > 0 &&
    caps.defaultAspectRatio &&
    caps.aspectRatios.includes(caps.defaultAspectRatio) &&
    caps.durationSeconds.min <= caps.durationSeconds.default &&
    caps.durationSeconds.default <= caps.durationSeconds.max,
  );
}

export function resolveVideoResolution(
  capabilities: NonNullable<ModelOption["videoCapabilities"]>,
  requested: string | null,
): string | null | undefined {
  const requestedValue = requested?.trim();
  // A catalog default can belong to a different channel than the eventual route.
  if (!requestedValue) return undefined;
  if (capabilities.resolutions.length === 0) {
    return /^(?:\d{3,4}p|\d{1,2}k)$/i.test(requestedValue) ? requestedValue : null;
  }
  return capabilities.resolutions.find((value) => value.toLowerCase() === requestedValue.toLowerCase()) ?? null;
}

function onboardingDebugDetails(
  eligibility: OnboardingEligibility | null,
  routed: RoutedIntent,
  finalTriggered: boolean,
) {
  return {
    serverEligible: eligibility?.eligible ?? false,
    completedTurns: eligibility?.completedTurns ?? null,
    currentTurn: eligibility?.currentTurn ?? null,
    promptCount: eligibility?.promptCount ?? 0,
    missingFields: eligibility?.missingFields ?? [],
    eligibilityReason: eligibility?.reason ?? "not_private_or_unavailable",
    conversationMode: routed.conversation_mode,
    modelOpportunity: routed.onboarding_opportunity,
    finalTriggered,
    profileUpdates: routed.profile_updates,
  };
}

function onboardingRoleKeyboard(language?: string | null): InlineKeyboard {
  const copy = onboardingCopy(language);
  const keyboard = new InlineKeyboard();
  ONBOARDING_ROLES.forEach((role, index) => {
    keyboard.text(copy.roles[role], `onboard:role:${role}`);
    if (index % 2 === 1) keyboard.row();
  });
  return keyboard.text(copy.other, "onboard:other").text(copy.later, "onboard:defer");
}

function imageActionKeyboard(userId: number, messageId: number, locale: BotLocale): InlineKeyboard {
  const prefix = `image_action:${userId}:${messageId}`;
  return new InlineKeyboard()
    .text(botText(locale, "analyzeImageButton"), `${prefix}:analyze`)
    .text(botText(locale, "editImageButton"), `${prefix}:edit`).row()
    .text(botText(locale, "animateImageButton"), `${prefix}:video`);
}

function miniAppUrl(dependencies: BotDependencies): string {
  return dependencies.miniAppUrl?.trim() || "https://apimaster.ai/mia/";
}

function introductionImageUrl(dependencies: BotDependencies): string {
  const imageUrl = new URL("mia-introduction.png", miniAppUrl(dependencies));
  imageUrl.searchParams.set("v", "1f3375c-banner");
  return imageUrl.toString();
}

function persistContextOnly(message: StorableMessage, dependencies: BotDependencies): boolean {
  try {
    captureMessage(message, dependencies.contexts);
    return true;
  } catch (error) {
    dependencies.logger.error(
      { err: error, chatId: message.chat.id, messageId: message.message_id },
      "Failed to persist Telegram message context",
    );
    return false;
  }
}

async function sendIntroductionActionPrompt(
  ctx: Context,
  sourceMessage: Message,
  actor: User,
  action: MiaIntroductionAction,
  dependencies: BotDependencies,
): Promise<void> {
  if (!dependencies.mediaStore) return;
  const locale = resolveBotLocale(actor.language_code);
  const copy = miaIntroductionActionPrompt(locale, action);
  const actorName = [actor.first_name, actor.last_name].filter(Boolean).join(" ") || actor.username || String(actor.id);
  const promptText = sourceMessage.chat.type === "private" ? copy.text : `${actorName}: ${copy.text}`;
  const prompt = await sendRichText(ctx, sourceMessage.chat.id, promptText, {
    ...threadOptionFromCallbackMessage(sourceMessage),
    reply_parameters: { message_id: sourceMessage.message_id, allow_sending_without_reply: true },
    reply_markup: {
      force_reply: true,
      selective: true,
      input_field_placeholder: copy.placeholder,
    },
  });
  const intent = action === "image" ? "image_generate" : action === "video" ? "video_generate" : "sticker_create";
  const instruction = action === "sticker" ? "制作一张贴纸" : "";
  dependencies.mediaStore.savePendingIntent({
    telegramUserId: actor.id,
    chatId: sourceMessage.chat.id,
    threadId: sourceMessage.message_thread_id ?? null,
    intent,
    slots: {
      intent,
      should_respond: true,
      response_to_message_id: null,
      confidence: 1,
      instruction,
      media_source: "none",
      media_message_ids: [],
      image_options: action === "image" || action === "sticker" ? { aspect_ratio: null } : null,
      video_options: action === "video" ? {
        mode: "text_to_video",
        duration_seconds: null,
        aspect_ratio: null,
        resolution: null,
        image_roles: [],
      } : null,
      reply: null,
      final_response: null,
      conversation_mode: "task",
      onboarding_opportunity: false,
      profile_updates: null,
    },
    missingRequired: action === "sticker" ? ["image", "callback_reply"] : ["instruction", "callback_reply"],
    sourceMessageIds: [sourceMessage.message_id, prompt.message_id],
  });
  persistMessage(prompt, dependencies);
}

async function handleIntroductionCallback(ctx: Context, dependencies: BotDependencies): Promise<boolean> {
  const query = ctx.callbackQuery;
  if (!query?.data) return false;
  const message = query.message;
  const match = /^intro_action:(image|video|sticker|chat|search)$/.exec(query.data);
  if (!match) return false;
  const action = match[1]!;
  const locale = resolveBotLocale(query.from.language_code);
  if (message?.chat.type === "private" && message.chat.id === query.from.id) {
    dependencies.activation?.markInteraction(query.from.id);
  }
  if (action === "chat" || action === "search") {
    await ctx.answerCallbackQuery();
    if (message) {
      await replyPlainTo(ctx, message, action === "chat"
        ? (locale === "zh-CN" ? "想聊什么？直接告诉我。" : "What would you like to talk about?")
        : (locale === "zh-CN" ? "想搜索什么？直接发给我，例如“今天北京天气”或“OpenAI 最新新闻”。" : "What would you like to search for? Send me a question, for example, today's weather in Beijing or the latest OpenAI news."));
    }
    return true;
  }
  const mediaAction = action as MiaIntroductionAction;
  if (!message || !dependencies.mediaStore || mediaAction === "sticker" && message.chat.type !== "private") {
    await ctx.answerCallbackQuery({ text: botText(locale, "actionUnavailable"), show_alert: true });
    return true;
  }
  await ctx.answerCallbackQuery();
  await sendIntroductionActionPrompt(ctx, message, query.from, mediaAction, dependencies);
  return true;
}

async function handleActivationCallback(ctx: Context, dependencies: BotDependencies): Promise<boolean> {
  const query = ctx.callbackQuery;
  const message = query?.message;
  if (!query?.data || !query.from || !message || !dependencies.activation || !query.data.startsWith("activation:")) return false;
  if (message.chat.type !== "private" || message.chat.id !== query.from.id) {
    await ctx.answerCallbackQuery({ text: botText(resolveBotLocale(query.from.language_code), "actionUnavailable"), show_alert: true });
    return true;
  }
  const locale = resolveBotLocale(query.from.language_code);
  const send = (text: string, replyMarkup?: InlineKeyboard) => ctx.api.sendMessage(message.chat.id, text, {
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  switch (query.data) {
    case "activation:ask":
      dependencies.activation.markInteraction(query.from.id);
      await ctx.answerCallbackQuery();
      await send(locale === "zh-CN" ? "想聊什么？直接告诉我。" : "What would you like to talk about?");
      return true;
    case "activation:search":
      dependencies.activation.markInteraction(query.from.id);
      await ctx.answerCallbackQuery();
      await send(locale === "zh-CN" ? "想搜索什么？直接发给我，例如“今天北京天气”或“OpenAI 最新新闻”。" : "What would you like to search for? Send me a question, for example, today's weather in Beijing or the latest OpenAI news.");
      return true;
    case "activation:companion":
      dependencies.activation.markInteraction(query.from.id);
      await ctx.answerCallbackQuery();
      await send(locale === "zh-CN" ? "我在。今天想从哪儿聊起？" : "I'm here. What would you like to start with?");
      return true;
    case "activation:weather":
      dependencies.activation.markInteraction(query.from.id);
      dependencies.activation.beginWeatherIntent(query.from.id, message.chat.id);
      await ctx.answerCallbackQuery();
      await send(locale === "zh-CN" ? "发一个城市名就行，例如“上海”或“Paris, France”。" : "Send a city name, for example Shanghai or Paris, France.");
      return true;
    case "activation:stop":
      dependencies.activation.dismiss(query.from.id, true);
      await ctx.answerCallbackQuery({ text: locale === "zh-CN" ? "已关闭提醒" : "Reminders turned off" });
      await ctx.api.editMessageReplyMarkup(message.chat.id, message.message_id, { reply_markup: { inline_keyboard: [] } });
      return true;
    case "activation:dismiss":
      dependencies.activation.dismiss(query.from.id, false);
      await ctx.answerCallbackQuery({ text: locale === "zh-CN" ? "好的，暂时不打扰。" : "Okay, not now." });
      await ctx.api.editMessageReplyMarkup(message.chat.id, message.message_id, { reply_markup: { inline_keyboard: [] } });
      return true;
    case "activation:weather:subscribe:8":
    case "activation:weather:subscribe:9": {
      const hour = query.data.endsWith(":8") ? 8 : 9;
      const subscription = dependencies.activation.subscribeWeather(query.from.id, hour);
      await ctx.answerCallbackQuery({ text: subscription ? (locale === "zh-CN" ? "天气订阅已开启" : "Weather subscription enabled") : (locale === "zh-CN" ? "请先查询一个城市的天气。" : "Check a city's weather first."), show_alert: !subscription });
      if (subscription) await send(locale === "zh-CN" ? `已订阅 ${subscription.location.name} 每天早上 ${hour}:00 的天气。` : `You'll receive ${subscription.location.name}'s weather every day at ${hour}:00.`);
      return true;
    }
    case "activation:weather:tomorrow": {
      const text = await dependencies.activation.weatherTextForRequest(query.from.id, query.from.language_code, true);
      await ctx.answerCallbackQuery();
      if (text) await send(text);
      return true;
    }
    case "activation:weather:pause":
      dependencies.activation.pauseWeather(query.from.id, false);
      await ctx.answerCallbackQuery({ text: locale === "zh-CN" ? "天气已暂停" : "Weather paused" });
      return true;
    case "activation:weather:cancel":
      dependencies.activation.pauseWeather(query.from.id, true);
      await ctx.answerCallbackQuery({ text: locale === "zh-CN" ? "天气订阅已取消" : "Weather subscription cancelled" });
      return true;
    default:
      return false;
  }
}

async function handleImageActionCallback(ctx: Context, dependencies: BotDependencies): Promise<boolean> {
  const query = ctx.callbackQuery;
  const message = query?.message;
  if (!query?.data || !query.from || !message || !dependencies.mediaStore) return false;
  const match = /^image_action:(\d+):(\d+):(analyze|edit|video)$/.exec(query.data);
  if (!match) return false;
  const ownerId = Number(match[1]);
  const sourceMessageId = Number(match[2]);
  const action = match[3];
  const locale = resolveBotLocale(query.from.language_code);
  if (ownerId !== query.from.id || dependencies.mediaStore.getTelegramMedia(message.chat.id, sourceMessageId).length === 0) {
    await ctx.answerCallbackQuery({ text: botText(locale, "actionUnavailable"), show_alert: true });
    return true;
  }
  const pendingScope = {
    telegramUserId: query.from.id,
    chatId: message.chat.id,
    threadId: "message_thread_id" in message ? message.message_thread_id ?? null : null,
  };
  const existing = dependencies.mediaStore.getPendingIntent(pendingScope);
  if (existing?.sourceMessageIds.includes(sourceMessageId)) {
    await ctx.answerCallbackQuery({ text: botText(locale, "actionUnavailable"), show_alert: true });
    return true;
  }
  const intent = action === "analyze" ? "vision_qa" : action === "edit" ? "image_edit" : "video_generate";
  const promptText = botText(locale, action === "analyze" ? "analyzeImagePrompt" : action === "edit" ? "editImagePrompt" : "animateImagePrompt");
  await ctx.answerCallbackQuery();
  await ctx.api.editMessageReplyMarkup(message.chat.id, message.message_id, { reply_markup: { inline_keyboard: [] } });
  const prompt = await sendRichText(ctx, message.chat.id, promptText, {
    ...threadOptionFromCallbackMessage(message),
    reply_parameters: { message_id: sourceMessageId, allow_sending_without_reply: true },
    reply_markup: { force_reply: true, selective: true },
  });
  dependencies.mediaStore.savePendingIntent({
    ...pendingScope,
    intent,
    slots: {
      intent,
      confidence: 1,
      instruction: "",
      media_source: "reply",
      media_message_ids: [sourceMessageId],
      image_options: action === "edit" ? { aspect_ratio: null } : null,
      video_options: action === "video" ? {
        mode: "image_to_video", duration_seconds: null, aspect_ratio: null, resolution: null, image_roles: ["first_frame"],
      } : null,
      reply: null,
      final_response: null,
      conversation_mode: "task",
      onboarding_opportunity: false,
      profile_updates: null,
    },
    missingRequired: [intent === "vision_qa" ? "question" : "instruction", "callback_reply"],
    sourceMessageIds: [sourceMessageId, prompt.message_id],
  });
  persistMessage(prompt, dependencies);
  return true;
}

async function maybeSendOnboardingPrompt(
  ctx: Context,
  message: Message,
  turn: number,
  dependencies: BotDependencies,
): Promise<boolean> {
  if (message.chat.type !== "private" || !message.from || !dependencies.onboarding) return false;
  const state = dependencies.onboarding.claimPrompt(message.from.id, turn);
  if (!state) return false;
  const missing = onboardingMissingFields(state);
  const copy = onboardingCopy(message.from.language_code);
  const sent = state.selectedRole === null
    ? await replyTo(ctx, message, copy.roleQuestion, { reply_markup: onboardingRoleKeyboard(message.from.language_code) })
    : await replyTo(ctx, message, onboardingMissingPrompt(message.from.language_code, missing));
  persistMessage(sent, dependencies);
  return true;
}

async function handleOnboardingCallback(ctx: Context, dependencies: BotDependencies): Promise<void> {
  const query = ctx.callbackQuery;
  const message = query?.message;
  if (!query?.data || !query.from || !message || message.chat.type !== "private" || !dependencies.onboarding) {
    if (query) await ctx.answerCallbackQuery({ text: onboardingCopy(query.from.language_code).alreadyHandled, show_alert: true });
    return;
  }
  const copy = onboardingCopy(query.from.language_code);
  if (query.data === "onboard:defer") {
    dependencies.onboarding.defer(query.from.id);
    await ctx.answerCallbackQuery();
    await editCallbackMessage(ctx, copy.deferred);
    return;
  }
  if (query.data === "onboard:other") {
    const result = dependencies.onboarding.selectRole(query.from.id, null, true, message.message_id);
    if (!result.created) {
      await ctx.answerCallbackQuery({ text: copy.alreadyHandled });
      return;
    }
    await ctx.answerCallbackQuery();
    await editCallbackMessage(ctx, copy.roleSaved);
    const sent = await sendRichText(ctx, message.chat.id, copy.customPrompt);
    persistMessage(sent, dependencies);
    return;
  }
  const match = /^onboard:role:([a-z_]+)$/.exec(query.data);
  const roleId = match?.[1] as OnboardingRoleId | undefined;
  if (!roleId || !ONBOARDING_ROLES.includes(roleId)) return;
  const role = onboardingRoleLabel("en", roleId);
  const result = dependencies.onboarding.selectRole(query.from.id, role, false);
  if (!result.created) {
    await ctx.answerCallbackQuery({ text: copy.alreadyHandled });
    return;
  }
  await ctx.answerCallbackQuery();
  await editCallbackMessage(ctx, `${copy.roleSaved} ${copy.roles[roleId]}`);
  const missing = onboardingMissingFields(result.state);
  if (missing.length > 0) {
    const sent = await sendRichText(ctx, message.chat.id, onboardingMissingPrompt(query.from.language_code, missing));
    persistMessage(sent, dependencies);
  }
}

async function handleTranslationCallback(ctx: Context, dependencies: BotDependencies): Promise<boolean> {
  const query = ctx.callbackQuery;
  const message = query?.message;
  if (!query?.data || !query.from || !message) return false;
  const action = parseTranslationCallback(query.data);
  if (!action) return false;
  const translations = translationStore(dependencies);
  const locale = resolveBotLocale(query.from.language_code);
  if (action.ownerId !== query.from.id || message.chat.type !== "private" || !translations) {
    await ctx.answerCallbackQuery({ text: botText(locale, "actionUnavailable"), show_alert: true });
    return true;
  }
  if (action.type === "exit") {
    translations.exitTranslationSession(action.ownerId, message.chat.id);
    await ctx.answerCallbackQuery();
    await sendTranslationCallbackState(ctx, message, botText(locale, "translationModeDisabled"));
    return true;
  }
  const session = getNormalizedTranslationSession(translations, action.ownerId, message.chat.id);
  if (!session) {
    await ctx.answerCallbackQuery({ text: botText(locale, "actionUnavailable"), show_alert: true });
    return true;
  }
  if (action.type === "switch") {
    await ctx.answerCallbackQuery();
    await sendTranslationCallbackState(
      ctx,
      message,
      botText(locale, "translationChoosePair"),
      translationPairKeyboard(action.ownerId, session, locale),
    );
    return true;
  }
  if (action.type === "back") {
    await ctx.answerCallbackQuery();
    await ctx.api.editMessageReplyMarkup(message.chat.id, message.message_id, {
      reply_markup: translationPairKeyboard(action.ownerId, session, locale),
    });
    return true;
  }
  if (action.type === "side") {
    await ctx.answerCallbackQuery();
    await ctx.api.editMessageReplyMarkup(message.chat.id, message.message_id, {
      reply_markup: translationLanguageKeyboard(action.ownerId, action.side, action.page, locale),
    });
    return true;
  }
  if (action.type === "page") {
    await ctx.answerCallbackQuery();
    await ctx.api.editMessageReplyMarkup(message.chat.id, message.message_id, {
      reply_markup: translationLanguageKeyboard(action.ownerId, action.side, action.page, locale),
    });
    return true;
  }
  if (action.type !== "set") return true;
  const updated = updateTranslationPair(session, action.side, action.language);
  const saved = translations.setTranslationLanguagePair(
    action.ownerId,
    message.chat.id,
    updated.leftLanguage,
    updated.rightLanguage,
  );
  if (!saved) {
    await ctx.answerCallbackQuery({ text: botText(locale, "actionUnavailable"), show_alert: true });
    return true;
  }
  await ctx.answerCallbackQuery();
  await ctx.api.editMessageReplyMarkup(message.chat.id, message.message_id, {
    reply_markup: translationPairKeyboard(action.ownerId, saved, locale),
  });
  return true;
}

async function handleCallback(ctx: Context, dependencies: BotDependencies): Promise<void> {
  const query = ctx.callbackQuery;
  if (!query || !query.data || !query.from) return;
  if (await handleActivationCallback(ctx, dependencies)) return;
  if (query.data.startsWith("onboard:")) {
    await handleOnboardingCallback(ctx, dependencies);
    return;
  }
  if (await handleTranslationCallback(ctx, dependencies)) return;
  if (await handleIntroductionCallback(ctx, dependencies)) return;
  if (await handleImageActionCallback(ctx, dependencies)) return;
  const unavailable = async () => {
    await ctx.answerCallbackQuery({
      text: botText(resolveBotLocale(query.from.language_code), "actionUnavailable"),
      show_alert: true,
    });
  };
  if (!dependencies.mediaStore) {
    await unavailable();
    return;
  }
  const match = /^media:(\d+):(generate|cancel|dur_up|dur_down|ratio|download|again|edit)$/.exec(query.data);
  if (!match) {
    await unavailable();
    return;
  }
  const jobId = Number(match[1]);
  const action = match[2];
  const job = dependencies.mediaStore.getJob(jobId);
  const locale = job ? mediaJobLocale(job.options, query.from.language_code) : resolveBotLocale(query.from.language_code);
  if (!job || job.telegramUserId !== query.from.id) {
    await ctx.answerCallbackQuery({ text: botText(locale, "actionUnavailable"), show_alert: true });
    return;
  }
  if (action === "generate") {
    if (!await ensureCallbackMediaAccess(ctx, job, dependencies, locale)) return;
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
    const hasResultMedia = resultMessageId !== null && resultMessageId !== undefined &&
      dependencies.mediaStore.getTelegramMedia(job.chatId, resultMessageId).length > 0;
    const hasStickerResult = resultMessageId !== null && resultMessageId !== undefined &&
      job.options.outputMode === "telegram_sticker";
    if (job.type === "video_generate" || !resultMessageId || (!hasResultMedia && !hasStickerResult)) {
      await ctx.answerCallbackQuery({ text: botText(locale, "actionUnavailable"), show_alert: true });
      return;
    }
    dependencies.mediaStore.savePendingIntent({
      ...scopeForJob(job),
      intent: job.options.outputMode === "telegram_sticker" ? "sticker_create" : "image_edit",
      slots: {
        intent: job.options.outputMode === "telegram_sticker" ? "sticker_create" : "image_edit",
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
        intent: job.options.outputMode === "telegram_sticker" ? "sticker_create" : "image_edit",
        slots: {
          intent: job.options.outputMode === "telegram_sticker" ? "sticker_create" : "image_edit",
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
    if (!await ensureCallbackMediaAccess(ctx, job, dependencies, locale)) return;
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

async function ensureCallbackMediaAccess(
  ctx: Context,
  job: MediaJob,
  dependencies: BotDependencies,
  locale: BotLocale,
): Promise<boolean> {
  try {
    await dependencies.client.resolveAPIKey(job.telegramUserId, job.model);
    return true;
  } catch (error) {
    const message = ctx.callbackQuery?.message;
    await ctx.answerCallbackQuery();
    if (message) await replyMediaAccessError(ctx, message, error, locale);
    return false;
  }
}

async function downloadResult(ctx: Context, job: MediaJob, dependencies: BotDependencies): Promise<void> {
  if (!ctx.callbackQuery || !dependencies.resultMaxBytes || !dependencies.mediaStore) {
    const locale = mediaJobLocale(job.options, ctx.from?.language_code);
    await ctx.answerCallbackQuery({ text: botText(locale, "originalUnavailable"), show_alert: true });
    return;
  }
  const locale = mediaJobLocale(job.options, ctx.from?.language_code);
  const local = dependencies.mediaStore.readLocalResult(job.id, job.resultMimeType);
  const resultUrl = job.resultUrl;
  if (local) {
    await ctx.answerCallbackQuery();
    try {
      await ctx.api.sendDocument(job.chatId, new InputFile(local.bytes, local.filename), threadOptionFromJob(job));
    } catch {
      await sendRichText(ctx, job.chatId, botText(locale, "downloadUnavailable"), threadOptionFromJob(job));
    }
    return;
  }
  if (!resultUrl) {
    await ctx.answerCallbackQuery({ text: botText(locale, "originalUnavailable"), show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  try {
    const apiKey = await dependencies.client.resolveAPIKey(job.telegramUserId, job.model);
    const media = await dependencies.client.getContent(apiKey, resultUrl, dependencies.resultMaxBytes);
    await ctx.api.sendDocument(job.chatId, new InputFile(media.bytes, media.filename), threadOptionFromJob(job));
  } catch {
    await sendRichText(ctx, job.chatId, botText(locale, "downloadUnavailable"), threadOptionFromJob(job));
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
    const credential = await resolveTextCredential(
      dependencies,
      ctx.from.id,
      selectedModel,
      dependencies.settings.getDefaults?.().chatModel ?? DEFAULT_MODELS.chat,
    );
    const model = credential.model;
    if (credential.source === "user" && !sameModelId(model, selectedModel)) {
      await ctx.reply(botText(locale, "chatModelFallback", { selected: selectedModel, model }));
    }
    if (!ctx.message) return;
    const requestContext = await buildRequestContext(
      ctx,
      ctx.message,
      dependencies,
      null,
      null,
      credential.source === "user",
    );
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
      details: {
        credentialSource: credential.source,
        credentialFallbackReason: credential.fallbackReason,
      },
    }) ?? null;
    const response = requestContext
      ? await dependencies.client.chatMessages(credential.apiKey, model, [
        { role: "system", content: promptText("mia.system", locale) },
        ...requestContext.messages,
      ])
      : await dependencies.client.chat(credential.apiKey, model, prompt, locale);
    const delivery = await sendConversationResponse(ctx, ctx.message, response, dependencies);
    const assistantMessageId = delivery.assistantMessageId;
    dependencies.debug?.finish(debugId, {
      status: "succeeded",
      responsePreview: response,
      details: {
        credentialSource: credential.source,
        credentialFallbackReason: credential.fallbackReason,
        presentation: delivery.presentation,
      },
    });
    recordCompletedChatTurn(ctx.message, assistantMessageId, dependencies);
    recordSuccessfulGroupTrigger(ctx.message, dependencies);
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
    typeof contexts.getReplyChain === "function" &&
    typeof contexts.getUser === "function" &&
    typeof contexts.listPendingCompletedTurns === "function";
}

async function buildRequestContext(
  ctx: Context,
  message: Message,
  dependencies: BotDependencies,
  activeMedia: MediaInput | null,
  currentTask: string | null,
  includeMedia: boolean | ReadonlySet<number> = true,
): Promise<{
  messages: ReturnType<typeof buildConversationMessages>;
  layers: DebugContextLayers;
  context: ReturnType<typeof loadConversationContext>;
  includedMediaMessageIds: number[];
} | null> {
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
  const downloadableInputs = includeMedia === true ? context.mediaInputs
    : includeMedia === false ? []
      : context.mediaInputs.filter((input) => includeMedia.has(input.messageId));
  const downloaded = downloadableInputs.length === 0 ? [] : await downloadConversationImages(
    ctx.api,
    dependencies.botToken,
    downloadableInputs,
    requiredMediaMessageIds,
  );
  const downloadedByMessageId = new Map(downloadableInputs.map((input, index) => [input.messageId, downloaded[index]]));
  const images = context.mediaInputs.map((input) => downloadedByMessageId.get(input.messageId));
  const includedMediaMessageIds = downloadableInputs.flatMap((input, index) => downloaded[index] ? [input.messageId] : []);
  return {
    messages: buildConversationMessages(context, images, ctx.me.id),
    layers: debugContextLayers(context),
    context,
    includedMediaMessageIds,
  };
}

async function resolveTextCredential(
  dependencies: BotDependencies,
  telegramUserId: number,
  requestedModel: string,
  fallbackUserModel?: string,
): Promise<ChatCredential> {
  if (dependencies.chatCredentials) {
    return dependencies.chatCredentials.resolve(telegramUserId, requestedModel, fallbackUserModel);
  }
  try {
    return {
      apiKey: await dependencies.client.resolveAPIKey(telegramUserId, requestedModel),
      model: requestedModel,
      source: "user",
      fallbackReason: null,
    };
  } catch (error) {
    if (!(error instanceof ResolverError) || error.code !== "no_usable_api_key" ||
        !fallbackUserModel || sameModelId(requestedModel, fallbackUserModel)) throw error;
    return {
      apiKey: await dependencies.client.resolveAPIKey(telegramUserId, fallbackUserModel),
      model: fallbackUserModel,
      source: "user",
      fallbackReason: null,
    };
  }
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

function recordSuccessfulGroupTrigger(message: Message, dependencies: BotDependencies): void {
  if (!message.from || message.chat.type === "private" || !dependencies.groupCompactor) return;
  const scope = conversationScope(message);
  if (scope.type === "private") return;
  dependencies.groupCompactor.recordSuccessfulGroupTrigger(scope, message.from.id);
}

async function handleGroupSummary(
  ctx: Context,
  message: Message,
  dependencies: BotDependencies,
  locale: BotLocale,
): Promise<void> {
  if (!message.from) return;
  if (message.chat.type === "private") {
    await replyTo(ctx, message, botText(locale, "groupSummaryGroupOnly"));
    return;
  }
  const scope = conversationScope(message);
  if (scope.type === "private") return;
  if (!dependencies.groupSummary) {
    await replyTo(ctx, message, botText(locale, "serviceUnavailable"));
    return;
  }
  await ctx.api.sendChatAction(message.chat.id, "typing", threadOption(message));
  let prepared;
  try {
    prepared = await dependencies.groupSummary.summarize({
      scope,
      requesterUserId: message.from.id,
      currentMessageId: message.message_id,
      locale,
    });
  } catch (error) {
    dependencies.logger.warn({ err: error, scope }, "Mia group summary failed");
    await replyTo(ctx, message, userFacingError(error, dependencies.groupSummary.model, locale));
    return;
  }
  if (!prepared) {
    await replyTo(ctx, message, botText(locale, "groupSummaryEmpty"));
    return;
  }
  let lastMessageId: number | null = null;
  const summaryMessageIds: number[] = [];
  let allPersisted = true;
  const deliveries: TelegramPresentationDelivery[] = [];
  try {
    for (const chunk of renderTelegramRich(groupSummaryPresentation(prepared.content, locale))) {
      const delivery = await sendTelegramPresentationChunk(ctx, message, chunk);
      deliveries.push(delivery);
      for (const sent of delivery.messages) {
        allPersisted = persistMessage(sent, dependencies) && allPersisted;
        lastMessageId = sent.message_id;
        summaryMessageIds.push(sent.message_id);
      }
    }
  } catch (error) {
    dependencies.groupSummary.failDelivery(prepared);
    throw error;
  }
  if (!allPersisted || lastMessageId === null) {
    dependencies.groupSummary.failDelivery(prepared);
    return;
  }
  dependencies.groupSummary.complete(prepared, lastMessageId, summaryMessageIds, presentationDebug(deliveries));
}

interface TelegramPresentationDelivery {
  messages: StorableMessage[];
  mode: "rich_message" | "html" | "plain_text" | "mixed";
  fallbackReasons: string[];
  richBlocks: unknown;
}

interface ConversationDelivery {
  assistantMessageId: number | null;
  presentation: ReturnType<typeof presentationDebug>;
}

async function sendConversationResponse(
  ctx: Context,
  message: Message,
  response: string | MiaResponse,
  dependencies: BotDependencies,
  finalMessageOptions: Record<string, unknown> = {},
): Promise<ConversationDelivery> {
  let lastMessageId: number | null = null;
  let allPersisted = true;
  const deliveries: TelegramPresentationDelivery[] = [];
  const presentation = typeof response === "string" ? miaResponseFromText(response) : response;
  const chunks = renderTelegramRich(presentation);
  for (const [index, chunk] of chunks.entries()) {
    const options = index === chunks.length - 1 ? finalMessageOptions : {};
    const delivery = await sendTelegramPresentationChunk(ctx, message, chunk, options);
    deliveries.push(delivery);
    for (const sent of delivery.messages) {
      allPersisted = persistMessage(sent, dependencies) && allPersisted;
      lastMessageId = sent.message_id;
    }
  }
  return {
    assistantMessageId: allPersisted ? lastMessageId : null,
    presentation: presentationDebug(deliveries),
  };
}

function presentationDebug(deliveries: readonly TelegramPresentationDelivery[]) {
  const modes = [...new Set(deliveries.map((delivery) => delivery.mode))];
  return {
    deliveryMode: modes.length === 1 ? modes[0] : "mixed",
    chunkCount: deliveries.reduce((sum, delivery) => sum + delivery.messages.length, 0),
    richMessages: deliveries.map((delivery) => ({ blocks: delivery.richBlocks })),
    fallbackReasons: [...new Set(deliveries.flatMap((delivery) => delivery.fallbackReasons))],
  };
}

export async function sendTelegramPresentationChunk(
  ctx: Context,
  message: Message,
  chunk: TelegramRichPresentationChunk,
  finalMessageOptions: Record<string, unknown> = {},
): Promise<TelegramPresentationDelivery> {
  try {
    const sent = await ctx.api.sendRichMessage(
      message.chat.id,
      chunk.richMessage,
      replyOptions(message, finalMessageOptions),
    );
    if (!isStorableMessage(sent)) throw new Error("invalid_rich_message_response");
    return { messages: [sent], mode: "rich_message", fallbackReasons: [], richBlocks: chunk.richBlocks };
  } catch {
    const messages: StorableMessage[] = [];
    const modes = new Set<"html" | "plain_text">();
    const fallbackReasons = ["send_rich_message_failed"];
    for (const [index, fallback] of chunk.htmlFallback.entries()) {
      const options = index === chunk.htmlFallback.length - 1 ? finalMessageOptions : {};
      try {
        const sent = await replyPlainTo(ctx, message, fallback.html, { parse_mode: "HTML", ...options });
        if (!isStorableMessage(sent)) throw new Error("invalid_html_message_response");
        messages.push(sent);
        modes.add("html");
      } catch {
        fallbackReasons.push("send_html_message_failed");
        const sent = await replyPlainTo(ctx, message, fallback.plainText, options);
        if (!isStorableMessage(sent)) throw new Error("invalid_plain_message_response");
        messages.push(sent);
        modes.add("plain_text");
      }
    }
    const mode = modes.size === 1 ? [...modes][0] ?? "plain_text" : "mixed";
    return { messages, mode, fallbackReasons, richBlocks: chunk.richBlocks };
  }
}

function directIntent(intent: PendingMediaIntent, instruction: string, mediaSource: RoutedIntent["media_source"]): RoutedIntent {
  return {
    intent,
    should_respond: true,
    response_to_message_id: null,
    confidence: 1,
    instruction,
    media_source: mediaSource,
    media_message_ids: [],
    image_options: intent === "image_generate" || intent === "image_edit" || intent === "sticker_create"
      ? { aspect_ratio: null }
      : null,
    video_options: intent === "video_generate" ? {
      mode: mediaSource === "none" ? "text_to_video" : "image_to_video",
      duration_seconds: null,
      aspect_ratio: null,
      resolution: null,
      image_roles: [],
    } : null,
    reply: null,
    final_response: null,
    conversation_mode: "task",
    onboarding_opportunity: false,
    profile_updates: null,
    missingRequired: instruction.trim() ? [] : [intent === "vision_qa" ? "question" : "instruction"],
  };
}

function parseExplicitCommand(text: string): { command: string; instruction: string } | null {
  const match = /^\/(image|vision|video|sticker|summary|new|forget|media_on|media_off|tr|ntr)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { command: match[1]?.toLowerCase() ?? "", instruction: match[2]?.trim() ?? "" } : null;
}

type TranslationSide = "left" | "right";

type TranslationCallback =
  | { type: "switch" | "exit" | "back"; ownerId: number }
  | { type: "side" | "page"; ownerId: number; side: TranslationSide; page: number }
  | { type: "set"; ownerId: number; side: TranslationSide; language: TranslationLanguage };

const TRANSLATION_PAGE_SIZE = 8;

function defaultTranslationLanguages(
  languageCode?: string | null,
  requestedTarget?: string,
  preference?: Pick<TranslationLanguagePreference, "leftLanguage" | "rightLanguage"> | null,
): { leftLanguage: TranslationLanguage; rightLanguage: TranslationLanguage } {
  const fallback = defaultTranslationPair(languageCode);
  const leftLanguage = canonicalTranslationLanguage(preference?.leftLanguage) ?? fallback.leftLanguage;
  const rightLanguage = canonicalTranslationLanguage(preference?.rightLanguage) ??
    (leftLanguage === "en" ? "zh-CN" : "en");
  const pair = leftLanguage === rightLanguage
    ? fallback
    : { leftLanguage, rightLanguage };
  const requestedLanguage = canonicalTranslationLanguage(requestedTarget);
  return requestedLanguage && requestedLanguage !== pair.leftLanguage
    ? { leftLanguage: pair.leftLanguage, rightLanguage: requestedLanguage }
    : pair;
}

function getNormalizedTranslationSession(
  store: TranslationStore,
  telegramUserId: number,
  chatId: number,
): TranslationSession | null {
  const session = store.getActiveTranslationSession(telegramUserId, chatId);
  if (!session) return null;
  const leftLanguage = canonicalTranslationLanguage(session.leftLanguage) ?? "en";
  const rightLanguage = canonicalTranslationLanguage(session.rightLanguage) ??
    (leftLanguage === "en" ? "zh-CN" : "en");
  const pair = leftLanguage === rightLanguage
    ? { leftLanguage, rightLanguage: leftLanguage === "en" ? "zh-CN" as const : "en" as const }
    : { leftLanguage, rightLanguage };
  if (pair.leftLanguage === session.leftLanguage && pair.rightLanguage === session.rightLanguage) return session;
  return store.setTranslationLanguagePair(telegramUserId, chatId, pair.leftLanguage, pair.rightLanguage) ?? null;
}

function updateTranslationPair(
  session: TranslationSession,
  side: TranslationSide,
  language: TranslationLanguage,
): Pick<TranslationSession, "leftLanguage" | "rightLanguage"> {
  if (side === "left") {
    return language === session.rightLanguage
      ? { leftLanguage: session.rightLanguage, rightLanguage: session.leftLanguage }
      : { leftLanguage: language, rightLanguage: session.rightLanguage };
  }
  return language === session.leftLanguage
    ? { leftLanguage: session.rightLanguage, rightLanguage: session.leftLanguage }
    : { leftLanguage: session.leftLanguage, rightLanguage: language };
}

function parseTranslationCallback(data: string): TranslationCallback | null {
  const parts = data.split(":");
  if (parts[0] !== "translation") return null;
  if ((parts[1] === "switch" || parts[1] === "exit") && parts.length === 3) {
    const ownerId = Number(parts[2]);
    return Number.isSafeInteger(ownerId) ? { type: parts[1], ownerId } : null;
  }
  if (parts[1] !== "pair" || parts.length < 4) return null;
  const ownerId = Number(parts[2]);
  if (!Number.isSafeInteger(ownerId)) return null;
  if (parts[3] === "back" && parts.length === 4) return { type: "back", ownerId };
  const side = parts[4] === "left" || parts[4] === "right" ? parts[4] : null;
  if (!side) return null;
  if (parts[3] === "side" && parts.length === 5) return { type: "side", ownerId, side, page: 0 };
  if (parts[3] === "page" && parts.length === 6) {
    const page = Number(parts[5]);
    return Number.isInteger(page) && page >= 0 && page < translationPageCount()
      ? { type: "page", ownerId, side, page }
      : null;
  }
  if (parts[3] === "set" && parts.length === 6) {
    const language = canonicalTranslationLanguage(parts[5]);
    return language ? { type: "set", ownerId, side, language } : null;
  }
  return null;
}

function translationPageCount(): number {
  return Math.ceil(TRANSLATION_PICKER_LANGUAGES.length / TRANSLATION_PAGE_SIZE);
}

function translationStatusKeyboard(userId: number, locale: BotLocale, includeCopyText?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (includeCopyText && [...includeCopyText].length <= 256) {
    keyboard.copyText(botText(locale, "translationCopyButton"), includeCopyText);
  }
  return keyboard
    .text(botText(locale, "translationSwitchButton"), `translation:switch:${userId}`)
    .text(botText(locale, "translationExitButton"), `translation:exit:${userId}`);
}

function translationPairKeyboard(userId: number, session: TranslationSession, locale: BotLocale): InlineKeyboard {
  return new InlineKeyboard()
    .text(translationLanguageLabel(session.leftLanguage as TranslationLanguage, locale), `translation:pair:${userId}:side:left`)
    .text(translationLanguageLabel(session.rightLanguage as TranslationLanguage, locale), `translation:pair:${userId}:side:right`)
    .row()
    .text(botText(locale, "translationExitButton"), `translation:exit:${userId}`);
}

function translationLanguageKeyboard(
  userId: number,
  side: TranslationSide,
  page: number,
  locale: BotLocale,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const start = page * TRANSLATION_PAGE_SIZE;
  const languages = TRANSLATION_PICKER_LANGUAGES.slice(start, start + TRANSLATION_PAGE_SIZE);
  for (let index = 0; index < languages.length; index += 2) {
    const first = languages[index];
    const second = languages[index + 1];
    if (first) keyboard.text(translationLanguageLabel(first, locale, { picker: true }), `translation:pair:${userId}:set:${side}:${first}`);
    if (second) keyboard.text(translationLanguageLabel(second, locale, { picker: true }), `translation:pair:${userId}:set:${side}:${second}`);
    keyboard.row();
  }
  if (page > 0) keyboard.text(botText(locale, "translationPreviousButton"), `translation:pair:${userId}:page:${side}:${page - 1}`);
  if (page < translationPageCount() - 1) keyboard.text(botText(locale, "translationNextButton"), `translation:pair:${userId}:page:${side}:${page + 1}`);
  if (page > 0 || page < translationPageCount() - 1) keyboard.row();
  return keyboard.text(botText(locale, "translationBackButton"), `translation:pair:${userId}:back`);
}

function translationStatusText(session: TranslationSession, locale: BotLocale): string {
  return botText(locale, "translationModeEnabled", {
    pair: `${translationLanguageLabel(session.leftLanguage as TranslationLanguage, locale)} ↔ ${translationLanguageLabel(session.rightLanguage as TranslationLanguage, locale)}`,
  });
}

type StartPayload = "sticker" | "settings" | { type: "login"; code: string };

function parseStartPayload(text: string): StartPayload | null {
  const match = /^\/start(?:@\w+)?\s+([^\s]+)$/i.exec(text.trim());
  const payload = match?.[1] ?? "";
  const normalized = payload.toLowerCase();
  if (normalized === "sticker" || normalized === "settings") return normalized;
  const login = /^login_([A-Za-z0-9_-]{32,128})$/.exec(payload);
  const code = login?.[1];
  return code ? { type: "login", code } : null;
}

async function handleTelegramDeepLinkLogin(
  ctx: Context,
  message: Message,
  code: string,
  dependencies: BotDependencies,
): Promise<void> {
  if (!message.from || message.chat.type !== "private") return;
  const locale = resolveBotLocale(message.from.language_code);
  const confirmation = await dependencies.client.confirmTelegramDeepLinkLogin({
    code,
    telegramUserId: message.from.id,
    firstName: message.from.first_name,
    ...(message.from.last_name ? { lastName: message.from.last_name } : {}),
    ...(message.from.username ? { username: message.from.username } : {}),
    ...(message.from.language_code ? { languageCode: message.from.language_code } : {}),
  });
  if (confirmation.kind === "expired") {
    await replyPlainTo(ctx, message, botText(locale, "telegramLoginExpired"));
    return;
  }
  if (confirmation.kind === "unavailable") {
    dependencies.logger.warn(
      { telegramUserId: message.from.id, status: confirmation.status },
      "Telegram deep-link confirmation is unavailable",
    );
    await replyPlainTo(ctx, message, botText(locale, "telegramLoginUnavailable"));
    return;
  }
  await replyPlainTo(ctx, message, botText(locale, "telegramLoginConfirmed"), {
    reply_markup: new InlineKeyboard().url(botText(locale, "telegramLoginButton"), confirmation.loginUrl),
  });
}

export function isExplicitGroupSummaryPhrase(text: string): boolean {
  const normalized = text.normalize("NFKC").trim();
  const chinese = /^(?:请|帮我|麻烦)?(?:总结|概括|回顾)(?:一下|下)?(?:刚才|刚刚|最近|上面|前面|这段|本群|群里|这个群|当前(?:话题|topic))?(?:的)?(?:聊天记录|聊天|讨论|对话|内容)?[吧。！？!?.]*$/i;
  const english = /^(?:please\s+)?(?:summarize|recap)(?:\s+(?:the|this|our))?\s+(?:chat|conversation|discussion|messages?|thread)(?:\s+(?:so far|above|just now|recently))?[.!?]*$/i;
  return chinese.test(normalized) || english.test(normalized);
}

function isMediaIntent(intent: RoutedIntent["intent"]): intent is PendingMediaIntent {
  return intent === "image_generate" || intent === "image_edit" ||
    intent === "sticker_create" || intent === "vision_qa" || intent === "video_generate";
}

function parseVideoOptions(text: string, hasImages: boolean) {
  const duration = /(?:^|\s)(\d{1,2})\s*(?:s|sec|seconds?|秒)(?:\s|$)/i.exec(text)?.[1];
  const ratio = /(?:^|\s)(1:1|16:9|9:16)(?:\s|$)/.exec(text)?.[1] as "1:1" | "16:9" | "9:16" | undefined;
  const resolution = /(?:^|\s)((?:\d{3,4}p)|(?:\d{1,2}k))(?:\s|$)/i.exec(text)?.[1]?.toUpperCase();
  const instruction = text
    .replace(/(?:^|\s)\d{1,2}\s*(?:s|sec|seconds?|秒)(?=\s|$)/ig, " ")
    .replace(/(?:^|\s)(?:(?:\d{3,4}p)|(?:\d{1,2}k)|1:1|16:9|9:16)(?=\s|$)/ig, " ")
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
    botText(locale, "resolutionLabel", {
      value: job.options.resolutionSource === "channel_default"
        ? botText(locale, "channelDefaultResolution")
        : String(job.options.resolution),
    }),
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

function groupConversationScope(message: Message): GroupConversationScope | null {
  const scope = conversationScope(message);
  return scope.type === "private" ? null : scope;
}

function followUpScopeKey(scope: GroupConversationScope): string {
  return scope.type === "topic" ? `${scope.chatId}:${scope.threadId}` : `${scope.chatId}:0`;
}

function followUpBatchText(batch: readonly IncomingMessage[]): string {
  return batch.map((item) => {
    const sender = item.message.from?.id ?? null;
    return `[message_id=${item.message.message_id} sender_user_id=${sender}]\n${item.text.trim()}`;
  }).join("\n\n");
}

function isDirectWake(message: Message, text: string, ctx: Context): boolean {
  if (message.chat.type === "private" || !message.from || !ctx.me) return false;
  const entities = "entities" in message ? message.entities :
    "caption_entities" in message ? message.caption_entities : undefined;
  return shouldRespond({
    chatType: message.chat.type,
    text,
    entities,
    repliedToUserId: message.reply_to_message?.from?.id,
  }, { id: ctx.me.id, username: ctx.me.username });
}

function threadOption(message: Message) {
  return message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id };
}

function threadOptionFromJob(job: MediaJob) {
  return job.threadId === null ? {} : { message_thread_id: job.threadId };
}

function threadOptionFromCallbackMessage(message: Message) {
  return message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id };
}

function replyOptions(message: Message, extra: Record<string, unknown> = {}) {
  return {
    ...threadOption(message),
    ...(message.chat.type === "private" ? {} : {
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    }),
    ...extra,
  };
}

function isStorableMessage(value: unknown): value is StorableMessage {
  return typeof value === "object" && value !== null && "message_id" in value &&
    typeof value.message_id === "number";
}

function replyPlainTo(ctx: Context, message: Message, text: string, extra: Record<string, unknown> = {}) {
  return ctx.api.sendMessage(message.chat.id, text, {
    ...replyOptions(message, extra),
  });
}

async function replyTo(ctx: Context, message: Message, text: string, extra: Record<string, unknown> = {}) {
  return sendRichText(ctx, message.chat.id, text, replyOptions(message, extra));
}

async function sendRichText(
  ctx: Context,
  chatId: number,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<StorableMessage> {
  return sendTelegramRichText(ctx.api, chatId, text, extra);
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

async function rejectUnavailableMediaUser(
  ctx: Context,
  message: Message,
  dependencies: BotDependencies,
): Promise<boolean> {
  if (!message.from) return true;
  try {
    if (dependencies.settings.getSnapshot) {
      await dependencies.settings.getSnapshot(message.from.id);
    } else {
      await dependencies.client.resolveAPIKey(
        message.from.id,
        dependencies.settings.getDefaults?.().imageModel ?? DEFAULT_MODELS.image,
      );
    }
    return false;
  } catch (error) {
    await replyMediaAccessError(ctx, message, error, resolveBotLocale(message.from.language_code));
    return true;
  }
}

async function replyMediaAccessError(
  ctx: Context,
  message: Message,
  error: unknown,
  locale: BotLocale,
): Promise<void> {
  if (error instanceof ResolverError && error.code === "telegram_not_bound") {
    const keyboard = new InlineKeyboard()
      .url(botText(locale, "telegramCreateOrLoginButton"), APIMASTER_TELEGRAM_LOGIN_URL)
      .row()
      .url(botText(locale, "telegramBindExistingButton"), APIMASTER_TELEGRAM_BIND_EXISTING_URL);
    await replyTo(ctx, message, botText(locale, "mediaBindRequired"), { reply_markup: keyboard });
    return;
  }
  if (error instanceof ResolverError && error.code === "no_usable_api_key") {
    const keyboard = new InlineKeyboard().url(
      botText(locale, "createTokenButton"),
      "https://apimaster.ai/console/tokens",
    );
    await replyTo(ctx, message, botText(locale, "mediaTokenRequired"), { reply_markup: keyboard });
    return;
  }
  if (error instanceof ResolverError && error.code === "selected_model_unavailable") {
    await replyTo(ctx, message, botText(locale, "selectedModelUnavailable"));
    return;
  }
  if (error instanceof ChatCompletionError && error.status === 402) {
    const keyboard = new InlineKeyboard().url(
      botText(locale, "topUpButton"),
      "https://apimaster.ai/console/wallet",
    );
    await replyTo(ctx, message, botText(locale, "mediaTopUpRequired"), { reply_markup: keyboard });
    return;
  }
  await replyTo(ctx, message, mediaError(error, locale));
}

async function editCallbackMessage(ctx: Context, text: string): Promise<void> {
  const message = ctx.callbackQuery?.message;
  if (message) await ctx.api.editMessageText(message.chat.id, message.message_id, text);
}

async function sendTranslationCallbackState(
  ctx: Context,
  message: Message,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  await ctx.api.editMessageReplyMarkup(message.chat.id, message.message_id, {
    reply_markup: { inline_keyboard: [] },
  });
  await replyPlainTo(ctx, message, text, keyboard ? { reply_markup: keyboard } : {});
}

export function createBot(token: string, dependencies: BotDependencies): Bot {
  const bot = new Bot(token);
  const albums = new Map<string, { ctx: Context; messages: Message[]; timer: NodeJS.Timeout }>();
  const sessions = followUpStore(dependencies);
  const dispatchIncoming = async (incoming: IncomingMessage): Promise<void> => {
    const { ctx, message } = incoming;
    const scope = groupConversationScope(message);
    if (!scope || !message.from || !ctx.me) {
      await handleIncoming({ ...incoming, triggerMode: "direct" }, dependencies);
      return;
    }

    const key = followUpScopeKey(scope);
    if (isDirectWake(message, incoming.text, ctx)) {
      followUps.cancel(key);
      sessions?.wakeGroupFollowUp(scope, message.from.id);
      await handleIncoming({ ...incoming, triggerMode: "direct" }, dependencies);
      return;
    }

    const policyInput = {
      chatType: message.chat.type,
      text: incoming.text,
      entities: "entities" in message ? message.entities :
        "caption_entities" in message ? message.caption_entities : undefined,
      repliedToUserId: message.reply_to_message?.from?.id,
    };
    const identity = { id: ctx.me.id, username: ctx.me.username };
    const immediate = parseExplicitCommand(incoming.text) !== null ||
      isExplicitGroupSummaryPhrase(promptFromMessage(policyInput, identity)) ||
      message.reply_to_message !== undefined && /^(?:@?mia)(?:\s|[,，:：])/i.test(incoming.text.trim()) ||
      Boolean(dependencies.mediaStore?.getPendingIntent?.(scopeFor(message)) && incoming.inputs.length > 0);
    if (immediate) {
      await handleIncoming({ ...incoming, triggerMode: "direct" }, dependencies);
      return;
    }

    if (incoming.text.trim() && sessions?.getActiveGroupFollowUp(scope) &&
        dependencies.followUpCredential && dependencies.router && dependencies.mediaStore) {
      followUps.enqueue(key, incoming);
      return;
    }
    await handleIncoming({ ...incoming, triggerMode: "direct" }, dependencies);
  };
  const followUps = new FollowUpCoordinator<IncomingMessage>({
    onBatch: async (_key, batch) => {
      const anchor = batch.at(-1);
      if (!anchor) return;
      const scope = groupConversationScope(anchor.message);
      if (!scope) return;
      const claim = sessions?.claimGroupFollowUpEvaluation(scope);
      if (claim?.outcome !== "claimed") {
        if (claim?.outcome === "rate_limited" && anchor.message.from && dependencies.followUpCredential) {
          const debugId = dependencies.debug?.start({
            telegramUserId: anchor.message.from.id,
            chatId: anchor.message.chat.id,
            chatType: anchor.message.chat.type,
            messageId: anchor.message.message_id,
            kind: "intent_router",
            model: dependencies.followUpCredential.model,
            promptRefs: [promptReference("mia.intent-router")],
            requestPreview: { followUpBatchMessageIds: batch.map((item) => item.message.message_id) },
            details: {
              triggerMode: "active_follow_up",
              followUpScope: claim.state.scope,
              rateLimitOutcome: "rate_limited",
              evaluationCount: claim.state.evaluationCount,
            },
          }) ?? null;
          dependencies.debug?.finish(debugId, {
            status: "succeeded",
            responsePreview: { shouldRespond: false, reason: "rate_limited" },
          });
        }
        return;
      }
      const seen = new Set<string>();
      const inputs = batch.flatMap((item) => item.inputs).filter((input) => {
        if (seen.has(input.fileId) || seen.size >= 10) return false;
        seen.add(input.fileId);
        return true;
      }).map((input, position) => ({ ...input, position }));
      let intervened = false;
      await handleIncoming({
        ...anchor,
        text: followUpBatchText(batch),
        inputs,
        triggerMode: "active_follow_up",
        batch,
        followUpState: claim.state,
        onIntervention: () => { intervened = true; },
      }, dependencies);
      if (intervened && sessions) sessions.markGroupFollowUpHandled(scope);
    },
    onError: (error, key) => dependencies.logger.warn({ err: error, scopeKey: key }, "Mia group follow-up failed"),
  });
  bot.on("message", async (ctx) => {
    const message = ctx.message;
    if (!("text" in message) && !("photo" in message) && !("document" in message) &&
        !("sticker" in message) && !("rich_message" in message)) return;
    if (!dependencies.agent?.ownsUpdate(ctx.update) && dependencies.mediaStore && !dependencies.mediaStore.claimTelegramUpdate(ctx.update.update_id)) return;
    const repliedMessage = message.reply_to_message;
    if (repliedMessage && isStorableMessage(repliedMessage)) {
      persistMessage(repliedMessage, dependencies);
    }
    persistMessage(message as StorableMessage, dependencies);
    if ("sticker" in message || "document" in message && !message.document.mime_type?.startsWith("image/")) return;
    const media = mediaFromMessage(message);
    if (media?.mediaGroupId && !dependencies.agent?.ownsUpdate(ctx.update)) {
      const key = `${message.chat.id}:${media.mediaGroupId}`;
      const existing = albums.get(key);
      if (existing) {
        existing.messages.push(message);
        clearTimeout(existing.timer);
        existing.timer = scheduleAlbum(key, albums, dispatchIncoming);
      } else {
        albums.set(key, { ctx, messages: [message], timer: scheduleAlbum(key, albums, dispatchIncoming) });
      }
      return;
    }
    await dispatchIncoming({
      ctx,
      message,
      text: messageText(message) ?? "",
      inputs: media ? [media] : [],
    });
  });
  bot.on("edited_message", (ctx) => {
    const message = ctx.editedMessage;
    if (!("text" in message) && !("photo" in message) && !("document" in message) &&
        !("sticker" in message) && !("rich_message" in message)) return;
    persistMessage(message as StorableMessage, dependencies);
  });
  bot.on("callback_query:data", (ctx) => {
    if (ctx.callbackQuery.data.startsWith("agent:") && dependencies.agent) {
      const [, id, revision, action] = ctx.callbackQuery.data.split(":");
      const message = ctx.callbackQuery.message;
      if (!id || !message) return ctx.answerCallbackQuery({ text: "Task unavailable" });
      const threadId = "message_thread_id" in message ? message.message_thread_id ?? null : null;
      const accepted = action === "approve"
        ? dependencies.agent.approve(id, Number(revision), ctx.from.id, message.chat.id, threadId)
        : action === "cancel" && dependencies.agent.cancelRun(id, ctx.from.id, message.chat.id, threadId, `callback:${ctx.update.update_id}`);
      return ctx.answerCallbackQuery({ text: accepted ? "OK" : "Task changed or confirmation expired" });
    }
    if (dependencies.mediaStore && !dependencies.mediaStore.claimTelegramUpdate(ctx.update.update_id)) return;
    return handleCallback(ctx, dependencies);
  });
  bot.catch(({ ctx, error }) => {
    dependencies.logger.error({ err: error, updateId: ctx.update.update_id }, "Unhandled Telegram update error");
    if (dependencies.agent?.ownsUpdate(ctx.update)) throw error;
  });
  return bot;
}

function scheduleAlbum(
  key: string,
  albums: Map<string, { ctx: Context; messages: Message[]; timer: NodeJS.Timeout }>,
  dispatchIncoming: (incoming: IncomingMessage) => Promise<void>,
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
    void dispatchIncoming({ ctx: album.ctx, message: anchor, text, inputs });
  }, 800);
  timer.unref();
  return timer;
}
