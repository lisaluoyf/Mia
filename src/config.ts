import { z } from "zod";

const environmentSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1),
  APIMASTER_BASE_URL: z.url(),
  APIMASTER_INTERNAL_BASE_URL: z.url().optional(),
  MIA_INTERNAL_SERVICE_KEY: z.string().trim().min(16),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3010),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(60000),
});

export interface AppConfig {
  telegramBotToken: string;
  apimasterBaseUrl: string;
  apimasterInternalBaseUrl: string;
  miaInternalServiceKey: string;
  host: string;
  port: number;
  logLevel: string;
  requestTimeoutMs: number;
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    apimasterBaseUrl: withoutTrailingSlash(parsed.APIMASTER_BASE_URL),
    apimasterInternalBaseUrl: withoutTrailingSlash(
      parsed.APIMASTER_INTERNAL_BASE_URL ?? parsed.APIMASTER_BASE_URL,
    ),
    miaInternalServiceKey: parsed.MIA_INTERNAL_SERVICE_KEY,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
  };
}
