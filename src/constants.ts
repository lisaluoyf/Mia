export const DEFAULT_MODELS = {
  chat: "grok-4.5",
  image: "gpt-image-2",
  video: "minimax-h3",
} as const;

export const TELEGRAM_MESSAGE_LIMIT = 4096;

// Mia-originated users authenticate with Telegram first. The legacy
// /connect/telegram route is only for an already signed-in website user who
// wants to complete optional community verification.
export const APIMASTER_TELEGRAM_LOGIN_URL = "https://apimaster.ai/api/auth/telegram/deep-link/start?next=%2Fmia%2F";
