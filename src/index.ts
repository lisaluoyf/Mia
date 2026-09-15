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
import { createBot } from "./telegram/bot.js";
import { botCommands } from "./telegram/commands.js";
import { IntentRouter } from "./intent/router.js";
import { configurePromptReader } from "./prompts.js";
import { PromptConfigStore } from "./prompt-config/store.js";
import { MediaStore } from "./media/store.js";
import { MediaWorker } from "./media/worker.js";
import { DebugRecorder } from "./debug/recorder.js";
import { DebugService } from "./debug/service.js";
import { DebugStore } from "./debug/store.js";
import { OnboardingService } from "./onboarding/service.js";
import { ChatCredentialResolver } from "./credentials/chat.js";
import { ModelConfigStore } from "./model-config/store.js";
import { AgentStore } from "./agent/store.js";
import { AgentService } from "./agent/service.js";
import { AgentLoopMonitor } from "./agent/loop-monitor.js";
import { ActivationStore } from "./activation/store.js";
import { ActivationService } from "./activation/service.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const client = new APIMasterClient({
    baseUrl: config.apimasterBaseUrl,
    internalBaseUrl: config.apimasterInternalBaseUrl,
    identityBaseUrl: config.apimasterIdentityBaseUrl,
    serviceKey: config.miaInternalServiceKey,
    timeoutMs: config.requestTimeoutMs,
  });
  const debugStore = new DebugStore(resolve(config.databasePath));
  const promptConfigs = new PromptConfigStore(resolve(config.databasePath));
  configurePromptReader(promptConfigs);
  const modelConfig = new ModelConfigStore(resolve(config.databasePath), {
    intent_router: config.miaRouterModel,
    private_compaction: config.miaContextModel,
    group_compaction: config.miaContextModel,
    guest_chat: config.miaGuestChatModel,
  });
  const debug = new DebugRecorder(debugStore);
  const refreshDebugUsers = async (): Promise<void> => {
    const ids = new Set(config.debugAllowedTelegramIds);
    try {
      for (const id of await client.resolveDebugTelegramUsers(config.debugAllowedEmails)) ids.add(id);
    } catch (error) {
      logger.warn({ err: error }, "Mia developer debug identities could not be refreshed");
    }
    debug.replaceAllowedUsers([...ids]);
    logger.info({ developerCount: ids.size }, "Mia developer debug identities refreshed");
  };
  await refreshDebugUsers();
  const debugRefreshTimer = setInterval(() => void refreshDebugUsers(), 60 * 60 * 1_000);
  debugRefreshTimer.unref();
  const store = new SettingsStore(resolve(config.databasePath), () => modelConfig.userDefaults());
  const contexts = new ContextStore(resolve(config.databasePath));
  const activationStore = new ActivationStore(resolve(config.databasePath));
  const chatCredentials = new ChatCredentialResolver(client, {
    apiKey: config.miaGuestChatApiKey,
    model: () => modelConfig.get("guest_chat") ?? config.miaGuestChatModel,
  });
  const compactor = new ContextCompactor({
    client,
    credentials: chatCredentials,
    store: contexts,
    logger,
    model: () => modelConfig.get("private_compaction") ?? config.miaContextModel,
    debug,
  });
  const groupCompactor = new GroupContextCompactor({
    client,
    credentials: chatCredentials,
    store: contexts,
    logger,
    model: () => modelConfig.get("group_compaction") ?? config.miaContextModel,
    debug,
  });
  const onboarding = new OnboardingService(contexts);
  const mediaStore = new MediaStore(resolve(config.databasePath));
  const settings = new ModelSettingsService(client, store, () => modelConfig.userDefaults());
  const agentStore = new AgentStore(resolve(config.databasePath));
  const agent = new AgentService({
    store: agentStore, media: mediaStore, client, settings, credentials: chatCredentials,
    contexts, logger, botToken: config.telegramBotToken, baseUrl: config.apimasterBaseUrl,
    model: () => modelConfig.get("intent_router") ?? config.miaRouterModel,
    timeoutMs: config.agentTimeoutMs, enabled: config.agentEnabled,
    webSearch: config.agentWebSearch, debug,
  });
  const router = new IntentRouter(client, {
    model: () => modelConfig.get("intent_router") ?? config.miaRouterModel,
    timeoutMs: config.miaRouterTimeoutMs,
  });
  const botDependencies: Parameters<typeof createBot>[1] = {
    agent,
    client,
    chatCredentials,
    logger,
    settings,
    contexts,
    compactor,
    groupCompactor,
    router,
    mediaStore,
    botToken: config.telegramBotToken,
    resultMaxBytes: config.mediaResultMaxBytes,
    webSearchModel: () => modelConfig.get("web_search_chat"),
    debug,
    onboarding,
    followUpCredential: {
      apiKey: config.miaGuestChatApiKey,
      get model() {
        return modelConfig.get("guest_chat") ?? config.miaGuestChatModel;
      },
    },
    miniAppUrl: config.publicBaseUrl ? `${config.publicBaseUrl}/mia/` : null,
  };
  const bot = createBot(config.telegramBotToken, botDependencies);
  await bot.init();
  agent.attach(bot.api, bot.botInfo.id, bot.botInfo.username);
  agent.start(update => bot.handleUpdate(update));
  const activation = new ActivationService({
    store: activationStore,
    client,
    api: bot.api,
    logger,
    enabled: config.activationEnabled,
    botUsername: bot.botInfo.username,
    miniAppUrl: config.publicBaseUrl ? `${config.publicBaseUrl}/mia/` : "https://apimaster.ai/mia/",
    dailyLimit: config.activationDailyLimit,
    intervalMs: config.activationIntervalMs,
    previewTelegramUserIds: config.activationPreviewTelegramUserIds,
  });
  const agentLoopMonitor = new AgentLoopMonitor({
    enabled: config.agentSmokeEnabled,
    userId: config.agentSmokeUserId,
    model: config.agentSmokeModel,
    intervalMs: config.agentSmokeIntervalMs,
    failureThreshold: config.agentSmokeFailureThreshold,
    timeoutMs: config.agentTimeoutMs,
    baseUrl: config.apimasterBaseUrl,
    client,
    logger,
  });
  botDependencies.activation = activation;
  try {
    await bot.api.setMyCommands(botCommands("en"));
    await bot.api.setMyCommands(botCommands("zh"), { language_code: "zh" });
  } catch (error) {
    logger.warn({ err: error }, "Mia Telegram commands could not be configured");
  }
  const worker = new MediaWorker({
    canSubmitAgentJob: job => agent.canSubmit(job),
    client,
    store: mediaStore,
    api: bot.api,
    botToken: config.telegramBotToken,
    logger,
    intervalMs: config.mediaWorkerIntervalMs,
    resultMaxBytes: config.mediaResultMaxBytes,
    publicBaseUrl: config.publicBaseUrl,
    botUsername: bot.botInfo.username,
    botUserId: bot.botInfo.id,
    contexts,
    debug,
  });
  worker.start();
  if (config.activationPreviewTelegramUserIds.length > 0) {
    void activation.sendPreviews().catch((error: unknown) => logger.warn({ err: error }, "Mia activation previews could not be sent"));
  }
  activation.start();
  agentLoopMonitor.start();
  const server = createServer({
    logger,
    serviceKey: config.miaInternalServiceKey,
    telegramWebhookSecret: config.telegramWebhookSecret,
    handleUpdate: (update) => bot.handleUpdate(update),
    enqueueUpdate: update => agent.enqueueUpdate(update),
    miniApp: {
      botToken: config.telegramBotToken,
      maxAuthAgeSeconds: config.miniAppAuthMaxAgeSeconds,
      settings,
      staticRoot: resolve("dist/web"),
    },
    mediaDownload: { store: mediaStore, client, publicBaseUrl: config.publicBaseUrl },
    debug: new DebugService(debugStore, contexts, modelConfig, client, promptConfigs),
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
    activation.stop();
    agentLoopMonitor.stop();
    await agent.stop();
    await worker.drain();
    agentStore.close();
    clearInterval(debugRefreshTimer);
    store.close();
    contexts.close();
    activationStore.close();
    mediaStore.close();
    debugStore.close();
    configurePromptReader(null);
    promptConfigs.close();
    modelConfig.close();
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
