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
  DATABASE_PATH: z.string().trim().min(1).default("data/mia.sqlite"),
  MINI_APP_AUTH_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(604800).default(86400),
  MIA_ROUTER_MODEL: z.string().trim().min(1).default("gpt-5.4"),
  MIA_ROUTER_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(8000),
  MIA_CONTEXT_MODEL: z.string().trim().min(1).default("gpt-5.4"),
  MIA_PUBLIC_BASE_URL: z.url().optional(),
  MEDIA_WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).max(60000).default(5000),
  MEDIA_RESULT_MAX_BYTES: z.coerce.number().int().min(1_000_000).max(2_000_000_000).default(50_000_000),
  MIA_DEBUG_ALLOWED_EMAILS: z.string().default("lisa.luoyf@gmail.com"),
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
  databasePath: string;
  miniAppAuthMaxAgeSeconds: number;
  miaRouterModel: string;
  miaRouterTimeoutMs: number;
  miaContextModel: string;
  publicBaseUrl: string | null;
  mediaWorkerIntervalMs: number;
  mediaResultMaxBytes: number;
  debugAllowedEmails: string[];
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
    databasePath: parsed.DATABASE_PATH,
    miniAppAuthMaxAgeSeconds: parsed.MINI_APP_AUTH_MAX_AGE_SECONDS,
    miaRouterModel: parsed.MIA_ROUTER_MODEL,
    miaRouterTimeoutMs: parsed.MIA_ROUTER_TIMEOUT_MS,
    miaContextModel: parsed.MIA_CONTEXT_MODEL,
    publicBaseUrl: parsed.MIA_PUBLIC_BASE_URL === undefined ? null : withoutTrailingSlash(parsed.MIA_PUBLIC_BASE_URL),
    mediaWorkerIntervalMs: parsed.MEDIA_WORKER_INTERVAL_MS,
    mediaResultMaxBytes: parsed.MEDIA_RESULT_MAX_BYTES,
    debugAllowedEmails: [...new Set(parsed.MIA_DEBUG_ALLOWED_EMAILS.split(",")
      .map((email) => email.trim().toLocaleLowerCase()).filter(Boolean))],
  };
}
