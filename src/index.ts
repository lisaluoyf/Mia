import { APIMasterClient } from "./clients/apimaster.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";
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
  await bot.init();
  const server = createServer({
    logger,
    serviceKey: config.miaInternalServiceKey,
    handleUpdate: (update) => bot.handleUpdate(update),
  });
  let stopping = false;

  const stop = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info({ signal }, "Stopping Mia");
    await server.close();
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
