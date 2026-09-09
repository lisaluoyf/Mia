import { z } from "zod";

const environmentSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1),
  APIMASTER_BASE_URL: z.url(),
  APIMASTER_INTERNAL_BASE_URL: z.url().optional(),
  APIMASTER_IDENTITY_BASE_URL: z.url(),
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
  // Agent model steps may include tool planning and need a longer total budget
  // than the fast intent-router request.
  MIA_ROUTER_TIMEOUT_MS: z.coerce.number().int().min(500).max(180000).default(90000),
  MIA_CONTEXT_MODEL: z.string().trim().min(1).default("gpt-5.4"),
  MIA_GUEST_CHAT_API_KEY: z.string().trim().min(1),
  MIA_GUEST_CHAT_MODEL: z.literal("gpt-5.4").default("gpt-5.4"),
  MIA_PUBLIC_BASE_URL: z.url().optional(),
  MEDIA_WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).max(60000).default(5000),
  MEDIA_RESULT_MAX_BYTES: z.coerce.number().int().min(1_000_000).max(2_000_000_000).default(50_000_000),
  MIA_DEBUG_ALLOWED_EMAILS: z.string().default("lisa.luoyf@gmail.com"),
  MIA_DEBUG_ALLOWED_TELEGRAM_IDS: z.string().default(""),
  MIA_AGENT_ENABLED: z.enum(["true", "false"]).default("false"),
  MIA_AGENT_WEB_SEARCH: z.enum(["true", "false"]).default("false"),
  MIA_AGENT_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(600_000).default(300_000),
  MIA_AGENT_SMOKE_ENABLED: z.enum(["true", "false"]).default("false"),
  MIA_AGENT_SMOKE_USER_ID: z.string().regex(/^\s*\d*\s*$/).default(""),
  MIA_AGENT_SMOKE_MODEL: z.string().trim().min(1).default("gpt-5.6-luna"),
  MIA_AGENT_SMOKE_INTERVAL_MS: z.coerce.number().int().min(300_000).max(86_400_000).default(21_600_000),
  MIA_AGENT_SMOKE_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(20).default(3),
  MIA_ACTIVATION_ENABLED: z.enum(["true", "false"]).default("false"),
  MIA_ACTIVATION_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(60_000),
  MIA_ACTIVATION_DAILY_LIMIT: z.coerce.number().int().min(1).max(10_000).default(50),
  MIA_ACTIVATION_PREVIEW_TELEGRAM_USER_IDS: z.string().default(""),
});

export interface AppConfig {
  telegramBotToken: string;
  apimasterBaseUrl: string;
  apimasterInternalBaseUrl: string;
  apimasterIdentityBaseUrl: string;
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
  miaGuestChatApiKey: string;
  miaGuestChatModel: string;
  publicBaseUrl: string | null;
  mediaWorkerIntervalMs: number;
  mediaResultMaxBytes: number;
  debugAllowedEmails: string[];
  debugAllowedTelegramIds: number[];
  agentEnabled: boolean;
  agentWebSearch: boolean;
  agentTimeoutMs: number;
  agentSmokeEnabled: boolean;
  agentSmokeUserId: number | null;
  agentSmokeModel: string;
  agentSmokeIntervalMs: number;
  agentSmokeFailureThreshold: number;
  activationEnabled: boolean;
  activationIntervalMs: number;
  activationDailyLimit: number;
  activationPreviewTelegramUserIds: number[];
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
    apimasterIdentityBaseUrl: withoutTrailingSlash(parsed.APIMASTER_IDENTITY_BASE_URL),
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
    miaGuestChatApiKey: parsed.MIA_GUEST_CHAT_API_KEY,
    miaGuestChatModel: parsed.MIA_GUEST_CHAT_MODEL,
    publicBaseUrl: parsed.MIA_PUBLIC_BASE_URL === undefined ? null : withoutTrailingSlash(parsed.MIA_PUBLIC_BASE_URL),
    mediaWorkerIntervalMs: parsed.MEDIA_WORKER_INTERVAL_MS,
    mediaResultMaxBytes: parsed.MEDIA_RESULT_MAX_BYTES,
    debugAllowedEmails: [...new Set(parsed.MIA_DEBUG_ALLOWED_EMAILS.split(",")
      .map((email) => email.trim().toLocaleLowerCase()).filter(Boolean))],
    debugAllowedTelegramIds: [...new Set(parsed.MIA_DEBUG_ALLOWED_TELEGRAM_IDS.split(",")
      .map((id) => Number(id.trim())).filter((id) => Number.isSafeInteger(id) && id > 0))],
    agentEnabled: parsed.MIA_AGENT_ENABLED === "true",
    agentWebSearch: parsed.MIA_AGENT_WEB_SEARCH === "true",
    agentTimeoutMs: parsed.MIA_AGENT_TIMEOUT_MS,
    agentSmokeEnabled: parsed.MIA_AGENT_SMOKE_ENABLED === "true",
    agentSmokeUserId: parsed.MIA_AGENT_SMOKE_USER_ID.trim() ? Number(parsed.MIA_AGENT_SMOKE_USER_ID.trim()) : null,
    agentSmokeModel: parsed.MIA_AGENT_SMOKE_MODEL,
    agentSmokeIntervalMs: parsed.MIA_AGENT_SMOKE_INTERVAL_MS,
    agentSmokeFailureThreshold: parsed.MIA_AGENT_SMOKE_FAILURE_THRESHOLD,
    activationEnabled: parsed.MIA_ACTIVATION_ENABLED === "true",
    activationIntervalMs: parsed.MIA_ACTIVATION_INTERVAL_MS,
    activationDailyLimit: parsed.MIA_ACTIVATION_DAILY_LIMIT,
    activationPreviewTelegramUserIds: [...new Set(parsed.MIA_ACTIVATION_PREVIEW_TELEGRAM_USER_IDS.split(",")
      .map((id) => Number(id.trim())).filter((id) => Number.isSafeInteger(id) && id > 0))],
  };
}
