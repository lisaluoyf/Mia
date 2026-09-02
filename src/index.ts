import { APIMasterClient } from "./clients/apimaster.js";
import { loadConfig } from "./config.js";
import { createHealthServer } from "./health.js";
import { createLogger } from "./logger.js";
import { createBot } from "./telegram/bot.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const client = new APIMasterClient({
    baseUrl: config.apimasterBaseUrl,
    internalBaseUrl: config.apimasterInternalBaseUrl,
    serviceKey: config.miaInternalServiceKey,
    timeoutMs: config.requestTimeoutMs,
  });
  const bot = createBot(config.telegramBotToken, { client, logger });
  const healthServer = createHealthServer(logger);
  let stopping = false;

  const stop = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info({ signal }, "Stopping Mia");
    await Promise.allSettled([bot.stop(), healthServer.close()]);
  };

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  await healthServer.listen({ host: config.host, port: config.port });
  logger.info({ host: config.host, port: config.port }, "Mia health server is listening");
  await bot.start({
    onStart: (botInfo) => {
      logger.info({ botId: botInfo.id, username: botInfo.username }, "Mia long polling started");
    },
  });
}

main().catch((error: unknown) => {
  const logger = createLogger("error");
  logger.fatal({ err: error }, "Mia failed to start");
  process.exitCode = 1;
});
