import pino, { type DestinationStream, type Logger } from "pino";

const sensitivePaths = [
  "apiKey",
  "serviceKey",
  "botToken",
  "telegramBotToken",
  "*.apiKey",
  "*.serviceKey",
  "*.botToken",
  "*.telegramBotToken",
  "headers.authorization",
  "headers.x-mia-internal-key",
  "req.headers.authorization",
  "req.headers.x-mia-internal-key",
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = {
      level,
      redact: {
        paths: sensitivePaths,
        censor: "[REDACTED]",
      },
    };
  return destination === undefined
    ? pino(options)
    : pino(options, destination);
}
