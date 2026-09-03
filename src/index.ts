import { resolve } from "node:path";

import { APIMasterClient } from "./clients/apimaster.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";
import { ModelSettingsService } from "./settings/service.js";
import { SettingsStore } from "./settings/store.js";
import { ContextStore } from "./storage/store.js";
import { ContextCompactor } from "./context/compactor.js";
import { GroupContextCompactor } from "./context/group-compactor.js";
import { GroupSummaryService } from "./context/group-summary.js";
import { createBot } from "./telegram/bot.js";
import { IntentRouter } from "./intent/router.js";
import { MediaStore } from "./media/store.js";
import { MediaWorker } from "./media/worker.js";
import { DebugRecorder } from "./debug/recorder.js";
import { DebugService } from "./debug/service.js";
import { DebugStore } from "./debug/store.js";
import { OnboardingService } from "./onboarding/service.js";
import { ChatCredentialResolver } from "./credentials/chat.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const client = new APIMasterClient({
    baseUrl: config.apimasterBaseUrl,
    internalBaseUrl: config.apimasterInternalBaseUrl,
    serviceKey: config.miaInternalServiceKey,
    timeoutMs: config.requestTimeoutMs,
  });
  const debugStore = new DebugStore(resolve(config.databasePath));
  const debug = new DebugRecorder(debugStore);
  const refreshDebugUsers = async (): Promise<void> => {
    try {
      const ids = await client.resolveDebugTelegramUsers(config.debugAllowedEmails);
      debug.replaceAllowedUsers(ids);
      logger.info({ developerCount: ids.length }, "Mia developer debug identities refreshed");
    } catch (error) {
      logger.warn({ err: error }, "Mia developer debug identities could not be refreshed");
    }
  };
  await refreshDebugUsers();
  const debugRefreshTimer = setInterval(() => void refreshDebugUsers(), 60 * 60 * 1_000);
  debugRefreshTimer.unref();
  const store = new SettingsStore(resolve(config.databasePath));
  const contexts = new ContextStore(resolve(config.databasePath));
  const chatCredentials = new ChatCredentialResolver(client, {
    apiKey: config.miaGuestChatApiKey,
    model: config.miaGuestChatModel,
  });
  const compactor = new ContextCompactor({
    client,
    credentials: chatCredentials,
    store: contexts,
    logger,
    model: config.miaContextModel,
    debug,
  });
  const groupCompactor = new GroupContextCompactor({
    client,
    credentials: chatCredentials,
    store: contexts,
    logger,
    model: config.miaContextModel,
    debug,
  });
  const groupSummary = new GroupSummaryService({
    client,
    credentials: chatCredentials,
    store: contexts,
    logger,
    model: config.miaContextModel,
    debug,
  });
  const onboarding = new OnboardingService(contexts);
  const mediaStore = new MediaStore(resolve(config.databasePath));
  const settings = new ModelSettingsService(client, store);
  const router = new IntentRouter(client, {
    model: config.miaRouterModel,
    timeoutMs: config.miaRouterTimeoutMs,
  });
  const bot = createBot(config.telegramBotToken, {
    client,
    chatCredentials,
    logger,
    settings,
    contexts,
    compactor,
    groupCompactor,
    groupSummary,
    router,
    mediaStore,
    botToken: config.telegramBotToken,
    resultMaxBytes: config.mediaResultMaxBytes,
    debug,
    onboarding,
    followUpCredential: {
      apiKey: config.miaGuestChatApiKey,
      model: config.miaGuestChatModel,
    },
  });
  await bot.init();
  const worker = new MediaWorker({
    client,
    store: mediaStore,
    api: bot.api,
    botToken: config.telegramBotToken,
    logger,
    intervalMs: config.mediaWorkerIntervalMs,
    resultMaxBytes: config.mediaResultMaxBytes,
    publicBaseUrl: config.publicBaseUrl,
    botUsername: bot.botInfo.username,
    debug,
  });
  worker.start();
  const server = createServer({
    logger,
    serviceKey: config.miaInternalServiceKey,
    handleUpdate: (update) => bot.handleUpdate(update),
    miniApp: {
      botToken: config.telegramBotToken,
      maxAuthAgeSeconds: config.miniAppAuthMaxAgeSeconds,
      settings,
      staticRoot: resolve("dist/web"),
    },
    mediaDownload: { store: mediaStore, client, publicBaseUrl: config.publicBaseUrl },
    debug: new DebugService(debugStore, contexts),
  });
  let stopping = false;

  const stop = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info({ signal }, "Stopping Mia");
    await server.close();
    worker.stop();
    clearInterval(debugRefreshTimer);
    store.close();
    contexts.close();
    mediaStore.close();
    debugStore.close();
  };

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  await server.listen({ host: config.host, port: config.port });
  logger.info({
    host: config.host,
    port: config.port,
    botId: bot.botInfo.id,
    username: bot.botInfo.username,
  }, "Mia webhook receiver is listening");
}

main().catch((error: unknown) => {
  const logger = createLogger("error");
  logger.fatal({ err: error }, "Mia failed to start");
  process.exitCode = 1;
});
