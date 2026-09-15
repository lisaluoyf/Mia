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
  "ctx.api.token",
  "err.ctx.api.token",
  "err.error.ctx.api.token",
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = {
      level,
      serializers: {
        req(request: { method?: string; url?: string; raw?: { url?: string } }) {
          const url = request.url ?? request.raw?.url;
          return {
            method: request.method,
            url: url?.replace(/(\/(?:media\/download|media\/share|share)\/)[^/?]+/g, "$1[REDACTED]"),
          };
        },
      },
      redact: {
        paths: sensitivePaths,
        censor: "[REDACTED]",
      },
    };
  return destination === undefined
    ? pino(options)
    : pino(options, destination);
}
