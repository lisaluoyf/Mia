import { ChatCompletionError, ResolverError } from "../clients/apimaster.js";

export function userFacingError(error: unknown, model = "the selected model"): string {
  if (error instanceof ResolverError) {
    if (error.code === "telegram_not_bound") {
      return "请先在 APIMaster 绑定这个 Telegram 账号，然后再试。";
    }
    if (error.code === "user_disabled") {
      return "这个 APIMaster 账号目前不可用，请先检查账号状态。";
    }
    if (error.code === "no_usable_api_key") {
      return `你的 APIMaster 账号目前没有可用于 ${model} 的 API Key。`;
    }
  }
  if (error instanceof ChatCompletionError && (error.status === 402 || error.status === 429)) {
    return "本次请求暂时无法完成，请检查 APIMaster 额度后再试。";
  }
  return "服务暂时不可用，请稍后再试。";
}
