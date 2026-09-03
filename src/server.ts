import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Update } from "grammy/types";
import type { Logger } from "pino";
import { z } from "zod";

import { registerMiniAppRoutes } from "./mini-app/routes.js";
import type { ModelSettingsService } from "./settings/service.js";
import type { APIMasterClient } from "./clients/apimaster.js";
import type { MediaStore } from "./media/store.js";
import { registerDebugRoutes } from "./debug/routes.js";
import type { DebugService } from "./debug/service.js";

const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
}).passthrough();

interface ServerOptions {
  logger: Logger;
  serviceKey: string;
  handleUpdate: (update: Update) => Promise<void>;
  miniApp?: {
    botToken: string;
    maxAuthAgeSeconds: number;
    settings: ModelSettingsService;
    staticRoot?: string;
  };
  mediaDownload?: {
    store: MediaStore;
    client: APIMasterClient;
    publicBaseUrl?: string | null;
  };
  debug?: DebugService;
}

function authenticated(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== "string") {
    return false;
  }
  const actualBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createServer({ logger, serviceKey, handleUpdate, miniApp, mediaDownload, debug }: ServerOptions) {
  const app = Fastify({ loggerInstance: logger, bodyLimit: 1024 * 1024, trustProxy: true });

  app.addHook("onRequest", (request, reply, done) => {
    if (request.url === "/mia" || request.url.startsWith("/mia/")) {
      reply.header("content-security-policy", "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org");
      reply.header("referrer-policy", "no-referrer");
      reply.header("x-content-type-options", "nosniff");
      reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    }
    done();
  });

  void app.register(rateLimit, { global: false });
  if (miniApp) {
    void app.register((instance, _options, done) => {
      registerMiniAppRoutes(instance, miniApp);
      done();
    });
    if (miniApp.staticRoot) {
      void app.register(fastifyStatic, {
        root: miniApp.staticRoot,
        prefix: "/mia/",
        decorateReply: true,
      });
      app.get("/mia", (_request, reply) => reply.redirect("/mia/"));
      app.get("/mia/debug", (_request, reply) => reply.sendFile("index.html"));
    }
  }

  if (debug) {
    void app.register((instance, _options, done) => {
      registerDebugRoutes(instance, { serviceKey, service: debug });
      done();
    });
  }

  app.get("/health", () => ({ status: "ok" }));
  if (mediaDownload) {
    const localShareResult = (token: string) => {
      const access = mediaDownload.store.getAccessToken(token, "share");
      const job = access ? mediaDownload.store.getJob(access.jobId) : null;
      if (!job || job.status !== "succeeded" || job.type === "video_generate") return null;
      const local = mediaDownload.store.getLocalResult(job.id, job.resultMimeType);
      return local?.mimeType.startsWith("image/") ? local : null;
    };
    const handleMediaDownload = async (
      request: FastifyRequest<{ Params: { token: string } }>,
      reply: FastifyReply,
    ) => {
      const access = mediaDownload.store.getAccessToken(request.params.token, "download");
      const job = access ? mediaDownload.store.getJob(access.jobId) : null;
      if (!job || job.status !== "succeeded") {
        return reply.code(404).send({ error: "download_not_found" });
      }
      try {
        const local = mediaDownload.store.getLocalResult(job.id, job.resultMimeType);
        if (local) {
          reply.header("content-type", local.mimeType);
          reply.header("content-length", String(local.size));
          reply.header("content-disposition", `attachment; filename="${local.filename}"`);
          reply.header("cache-control", "private, no-store");
          return reply.send(createReadStream(local.path));
        }
        if (!job.resultUrl) return reply.code(404).send({ error: "download_not_found" });
        const apiKey = await mediaDownload.client.resolveAPIKey(job.telegramUserId, job.model);
        const upstream = await mediaDownload.client.streamContent(apiKey, job.resultUrl);
        if (!upstream.body) return reply.code(502).send({ error: "download_unavailable" });
        const contentType = upstream.headers.get("content-type");
        const contentLength = upstream.headers.get("content-length");
        if (contentType) reply.header("content-type", contentType);
        if (contentLength) reply.header("content-length", contentLength);
        reply.header("content-disposition", `attachment; filename="mia-${job.type === "video_generate" ? "video.mp4" : "image.png"}"`);
        reply.header("cache-control", "private, no-store");
        return reply.send(Readable.fromWeb(upstream.body as NodeReadableStream));
      } catch {
        return reply.code(502).send({ error: "download_unavailable" });
      }
    };
    // The public reverse proxy mounts Mia below /mia. Keep the short route for
    // internal callers and old links, while making the externally shared URL
    // resolve through the same handler.
    app.get<{ Params: { token: string } }>("/media/download/:token", handleMediaDownload);
    app.get<{ Params: { token: string } }>("/mia/media/download/:token", handleMediaDownload);
    app.get<{ Params: { token: string } }>("/mia/media/share/:token", (request, reply) => {
      const local = localShareResult(request.params.token);
      if (!local) return reply.code(404).send({ error: "share_not_found" });
      reply.header("content-type", local.mimeType);
      reply.header("content-length", String(local.size));
      reply.header("cache-control", "public, max-age=300");
      return reply.send(createReadStream(local.path));
    });
    app.get<{ Params: { token: string } }>("/mia/share/:token", (request, reply) => {
      const local = localShareResult(request.params.token);
      const publicBaseUrl = mediaDownload.publicBaseUrl;
      if (!local || !publicBaseUrl) return reply.code(404).type("text/plain").send("Share link expired");
      const imageUrl = `${publicBaseUrl}/mia/media/share/${request.params.token}`;
      reply.header("cache-control", "public, max-age=300");
      reply.header("x-robots-tag", "noindex, nofollow");
      return reply.type("text/html; charset=utf-8").send(sharePage(imageUrl));
    });
  }
  app.post("/telegram/update", (request, reply) => {
    if (!authenticated(request.headers["x-mia-internal-key"], serviceKey)) {
      return reply.code(401).send({ accepted: false });
    }

    const parsed = telegramUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ accepted: false });
    }
    const update = parsed.data as Update;
    setImmediate(() => {
      void handleUpdate(update).catch((error: unknown) => {
        logger.error({ err: error, updateId: update.update_id }, "Telegram update processing failed");
      });
    });
    return reply.code(202).send({ accepted: true });
  });

  return app;
}

function sharePage(imageUrl: string): string {
  const escapedUrl = escapeHtml(imageUrl);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Created with Mia</title>
  <meta name="description" content="An image created with Mia">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Mia">
  <meta property="og:title" content="Created with Mia">
  <meta property="og:description" content="An image created with Mia">
  <meta property="og:image" content="${escapedUrl}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Created with Mia">
  <meta name="twitter:description" content="An image created with Mia">
  <meta name="twitter:image" content="${escapedUrl}">
  <style>html,body{margin:0;min-height:100%;background:#111;color:#fff;font-family:system-ui,sans-serif}main{width:min(100%,960px);margin:auto;padding:24px;box-sizing:border-box}h1{font-size:20px;font-weight:600}img{display:block;width:100%;height:auto;max-height:calc(100vh - 100px);object-fit:contain;background:#000}</style>
</head>
<body><main><h1>Created with Mia</h1><img src="${escapedUrl}" alt="An image created with Mia"></main></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
