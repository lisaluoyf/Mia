import { Bot, type Context, type Filter } from "grammy";
import type { Logger } from "pino";

import type { APIMasterClient } from "../clients/apimaster.js";
import { userFacingError } from "./messages.js";
import { promptFromMessage, shouldRespond } from "./policy.js";
import { splitText } from "./split-text.js";

type TextContext = Filter<Context, "message:text">;

interface BotDependencies {
  client: APIMasterClient;
  logger: Logger;
}

export function createTextHandler({ client, logger }: BotDependencies) {
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
      const apiKey = await client.resolveAPIKey(ctx.from.id);
      const response = await client.chat(apiKey, promptFromMessage(input, identity));
      for (const chunk of splitText(response)) {
        await ctx.reply(chunk);
      }
    } catch (error) {
      logger.warn(
        { err: error, telegramUserId: ctx.from.id, updateId: ctx.update.update_id },
        "Telegram text request failed",
      );
      await ctx.reply(userFacingError(error));
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
