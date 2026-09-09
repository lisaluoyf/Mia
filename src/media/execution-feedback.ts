import { InlineKeyboard } from "grammy";
import { MediaAPIError, ResolverError } from "../clients/apimaster.js";
import { APIMASTER_TELEGRAM_BIND_EXISTING_URL, APIMASTER_TELEGRAM_LOGIN_URL } from "../constants.js";
import { botText } from "../telegram/localization.js";

export type MediaExecutionBlock = "insufficient_quota" | "telegram_not_bound" | "no_usable_api_key" | "selected_model_unavailable";

export function mediaExecutionBlock(error: unknown, status?: number): MediaExecutionBlock | null {
  const code = typeof error === "string" ? error : error instanceof MediaAPIError || error instanceof ResolverError ? error.code : null;
  const httpStatus = status ?? (error instanceof MediaAPIError || error instanceof ResolverError ? error.status : undefined);
  if (httpStatus === 402 || code === "insufficient_quota" || code === "insufficient_user_quota") return "insufficient_quota";
  if (code === "telegram_not_bound" || code === "no_usable_api_key" || code === "selected_model_unavailable") return code;
  return null;
}

export function mediaExecutionFeedback(block: MediaExecutionBlock, language: string): { text: string; keyboard: InlineKeyboard } {
  if (block === "insufficient_quota") return {
    text: botText(language, "mediaTopUpRequired"),
    keyboard: new InlineKeyboard().url(botText(language, "topUpButton"), "https://apimaster.ai/console/wallet"),
  };
  if (block === "telegram_not_bound") return {
    text: botText(language, "mediaBindRequired"),
    keyboard: new InlineKeyboard()
      .url(botText(language, "telegramCreateOrLoginButton"), APIMASTER_TELEGRAM_LOGIN_URL)
      .row()
      .url(botText(language, "telegramBindExistingButton"), APIMASTER_TELEGRAM_BIND_EXISTING_URL),
  };
  if (block === "no_usable_api_key") return {
    text: botText(language, "mediaTokenRequired"),
    keyboard: new InlineKeyboard().url(botText(language, "createTokenButton"), "https://apimaster.ai/console/tokens"),
  };
  return { text: botText(language, "selectedModelUnavailable"), keyboard: new InlineKeyboard() };
}
