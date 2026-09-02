import { ChatCompletionError, ResolverError } from "../clients/apimaster.js";
import { botText } from "./localization.js";

export function userFacingError(
  error: unknown,
  model = "the selected model",
  language?: string | null,
): string {
  if (error instanceof ResolverError) {
    if (error.code === "telegram_not_bound") {
      return botText(language, "telegramNotBound");
    }
    if (error.code === "user_disabled") {
      return botText(language, "accountDisabled");
    }
    if (error.code === "no_usable_api_key") {
      return botText(language, "noUsableKey", { model });
    }
  }
  if (error instanceof ChatCompletionError && (error.status === 402 || error.status === 429)) {
    return botText(language, "quotaUnavailable");
  }
  return botText(language, "serviceUnavailable");
}
