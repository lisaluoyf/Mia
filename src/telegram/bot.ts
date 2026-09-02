import { Bot, type Context, type Filter } from "grammy";
import type { Logger } from "pino";

import type { APIMasterClient } from "../clients/apimaster.js";
import { ResolverError } from "../clients/apimaster.js";
import { DEFAULT_MODELS } from "../constants.js";
import type { ModelSettingsService } from "../settings/service.js";
import type { ContextStore } from "../storage/store.js";
import { userFacingError } from "./messages.js";
import { promptFromMessage, shouldRespond } from "./policy.js";
import { splitText } from "./split-text.js";

type TextContext = Filter<Context, "message:text">;
type EditedTextContext = Filter<Context, "edited_message:text">;
type StorableTextMessage = TextContext["message"] | EditedTextContext["editedMessage"];

interface BotDependencies {
  client: APIMasterClient;
  logger: Logger;
  settings: Pick<ModelSettingsService, "getPreferences">;
  contexts: Pick<ContextStore, "upsertUser" | "upsertChat" | "upsertMember" | "saveMessage">;
}

function captureTextMessage(message: StorableTextMessage, contexts: BotDependencies["contexts"]): void {
  const from = message.from;
  contexts.upsertUser({
    telegramUserId: from.id,
    firstName: from.first_name,
    lastName: from.last_name ?? null,
    username: from.username ?? null,
    languageCode: from.language_code ?? null,
    isBot: from.is_bot,
  });
  contexts.upsertChat({
    chatId: message.chat.id,
    type: message.chat.type,
    title: "title" in message.chat ? message.chat.title ?? null : null,
    username: "username" in message.chat ? message.chat.username ?? null : null,
    description: null,
    isForum: "is_forum" in message.chat ? message.chat.is_forum ?? false : false,
  });
  contexts.upsertMember({
    chatId: message.chat.id,
    telegramUserId: from.id,
    status: null,
  });
  contexts.saveMessage({
    chatId: message.chat.id,
    messageId: message.message_id,
    threadId: message.message_thread_id ?? null,
    senderUserId: from.id,
    senderChatId: message.sender_chat?.id ?? null,
    replyToMessageId: message.reply_to_message?.message_id ?? null,
    contentType: "text",
    text: message.text,
    caption: null,
    entitiesJson: message.entities ? JSON.stringify(message.entities) : null,
    mediaFileId: null,
    mediaUniqueId: null,
    sentAt: new Date(message.date * 1000).toISOString(),
    editedAt: message.edit_date ? new Date(message.edit_date * 1000).toISOString() : null,
  });
}

function persistTextMessage(
  message: StorableTextMessage,
  contexts: BotDependencies["contexts"],
  logger: Logger,
): void {
  try {
    captureTextMessage(message, contexts);
  } catch (error) {
    logger.error(
      { err: error, chatId: message.chat.id, messageId: message.message_id },
      "Failed to persist Telegram message context",
    );
  }
}

export function createTextHandler({ client, logger, settings, contexts }: BotDependencies) {
  return async (ctx: TextContext): Promise<void> => {
    persistTextMessage(ctx.message, contexts, logger);
    const input = {
      chatType: ctx.chat.type,
      text: ctx.message.text,
      entities: ctx.message.entities,
      repliedToUserId: ctx.message.reply_to_message?.from?.id,
    };
    const identity = { id: ctx.me.id, username: ctx.me.username };
    if (!shouldRespond(input, identity)) {
      return;
    }

    try {
      await ctx.api.sendChatAction(ctx.chat.id, "typing");
      const selectedModel = settings.getPreferences(ctx.from.id).chatModel ?? DEFAULT_MODELS.chat;
      let model = selectedModel;
      let apiKey: string;
      try {
        apiKey = await client.resolveAPIKey(ctx.from.id, model);
      } catch (error) {
        if (!(error instanceof ResolverError) || error.code !== "no_usable_api_key" || model === DEFAULT_MODELS.chat) {
          throw error;
        }
        model = DEFAULT_MODELS.chat;
        apiKey = await client.resolveAPIKey(ctx.from.id, model);
        await ctx.reply(`The selected model ${selectedModel} is unavailable. Using ${model} for this reply.`);
      }
      const response = await client.chat(apiKey, model, promptFromMessage(input, identity));
      for (const chunk of splitText(response)) {
        await ctx.reply(chunk);
      }
    } catch (error) {
      logger.warn(
        { err: error, telegramUserId: ctx.from.id, updateId: ctx.update.update_id },
        "Telegram text request failed",
      );
      const model = settings.getPreferences(ctx.from.id).chatModel ?? DEFAULT_MODELS.chat;
      await ctx.reply(userFacingError(error, model));
    }
  };
}

export function createBot(token: string, dependencies: BotDependencies): Bot {
  const bot = new Bot(token);
  bot.on("message:text", createTextHandler(dependencies));
  bot.on("edited_message:text", (ctx) => {
    persistTextMessage(ctx.editedMessage, dependencies.contexts, dependencies.logger);
  });
  bot.catch(({ ctx, error }) => {
    dependencies.logger.error(
      { err: error, updateId: ctx.update.update_id },
      "Unhandled Telegram update error",
    );
  });
  return bot;
}
