export const DEFAULT_MODELS = {
  chat: "grok-4.5",
  image: "gpt-image-2",
  video: "minimax-h3",
} as const;

export const SYSTEM_PROMPT = `You are Mia, a concise AI assistant in Telegram.
Answer in the same language as the user.`;

export const TELEGRAM_MESSAGE_LIMIT = 4096;
