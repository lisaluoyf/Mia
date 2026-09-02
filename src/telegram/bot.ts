import { Bot, type Context, type Filter } from "grammy";
import type { Logger } from "pino";

import type { APIMasterClient } from "../clients/apimaster.js";
import { ResolverError } from "../clients/apimaster.js";
import { DEFAULT_MODELS } from "../constants.js";
import type { ModelSettingsService } from "../settings/service.js";
import { userFacingError } from "./messages.js";
import { promptFromMessage, shouldRespond } from "./policy.js";
import { splitText } from "./split-text.js";

type TextContext = Filter<Context, "message:text">;

interface BotDependencies {
  client: APIMasterClient;
  logger: Logger;
  settings: Pick<ModelSettingsService, "getPreferences">;
}

export function createTextHandler({ client, logger, settings }: BotDependencies) {
  return async (ctx: TextContext): Promise<void> => {
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
  bot.catch(({ ctx, error }) => {
    dependencies.logger.error(
      { err: error, updateId: ctx.update.update_id },
      "Unhandled Telegram update error",
    );
  });
  return bot;
}
