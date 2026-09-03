import { InlineKeyboard, InputFile, type Api } from "grammy";
import type { Logger } from "pino";

import type { APIMasterClient, NormalizedTaskStatus } from "../clients/apimaster.js";
import type { DebugRecorder } from "../debug/recorder.js";
import type { MediaStore } from "./store.js";
import type { MediaJob } from "./types.js";
import { dataUrl, downloadTelegramImages } from "./intake.js";
import { botText, mediaJobLocale } from "../telegram/localization.js";

interface WorkerOptions {
  client: APIMasterClient;
  store: MediaStore;
  api: Api;
  botToken: string;
  logger: Logger;
  intervalMs: number;
  resultMaxBytes: number;
  publicBaseUrl: string | null;
  debug?: DebugRecorder;
}

export class MediaWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly retries = new Map<number, { attempts: number; nextAt: number }>();

  constructor(private readonly options: WorkerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const job of this.options.store.listTimedOutJobs()) {
        await this.expireTelegramState(job);
      }
      for (const job of this.options.store.listRetentionExpiredJobs()) {
        if (job.statusMessageId) {
          await this.options.api.editMessageReplyMarkup(job.chatId, job.statusMessageId, { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
        }
      }
      this.options.store.cleanupExpired();
      for (const job of this.options.store.listResumableJobs()) {
        const retry = this.retries.get(job.id);
        if (retry && retry.nextAt > Date.now()) continue;
        try {
          await this.process(job);
          this.retries.delete(job.id);
        } catch (error) {
          const attempts = (retry?.attempts ?? 0) + 1;
          this.retries.set(job.id, { attempts, nextAt: Date.now() + Math.min(60_000, 2 ** attempts * 1_000) });
          this.options.logger.warn(
            { err: error, jobId: job.id, telegramUserId: job.telegramUserId, status: job.status, model: job.model },
            "Mia media worker step failed",
          );
          await this.updateStatus(job, botText(mediaJobLocale(job.options), "temporaryError"));
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async expireTelegramState(job: MediaJob): Promise<void> {
    if (!job.statusMessageId) return;
    const locale = mediaJobLocale(job.options);
    const text = botText(locale, job.status === "draft" ? "videoDraftExpired" : "mediaTimedOut");
    await this.options.api.editMessageText(job.chatId, job.statusMessageId, text, { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
  }

  private async process(job: MediaJob): Promise<void> {
    if (job.status === "queued") {
      await this.submit(job);
      return;
    }
    if (job.status === "submitting") {
      // The provider may already have accepted this request. Never auto-submit an
      // indeterminate task after restart or connection loss.
      this.options.store.transitionJob(job.id, ["submitting"], "failed", {
        errorCode: "submission_outcome_unknown",
      });
      await this.notifyFailure(job, botText(mediaJobLocale(job.options), "submissionUnknown"));
      return;
    }
    if (job.status === "submitted" || job.status === "in_progress") {
      await this.poll(job);
    }
  }

  private async submit(job: MediaJob): Promise<void> {
    const claimed = this.options.store.transitionJob(job.id, ["queued"], "submitting");
    if (!claimed) return;
    let apiKey: string;
    const inputs = this.options.store.listJobInputs(job.id);
    const debugId = this.options.debug?.start({
      telegramUserId: job.telegramUserId,
      chatId: job.chatId,
      chatType: job.chatId === job.telegramUserId ? "private" : "group",
      messageId: job.requestMessageId,
      kind: job.type,
      model: job.model,
      requestPreview: { instruction: job.instruction, options: job.options },
      media: inputs.map((input, index) => ({
        messageId: input.messageId,
        type: input.type,
        mimeType: input.mimeType,
        role: job.type === "video_generate"
          ? index === 0 ? "first_frame" : index === 1 ? "last_frame" : "reference_image"
          : "reference_image",
      })),
      details: { mediaJobId: job.id, phase: "submission" },
      externalKey: `media-job:${job.id}`,
    }) ?? null;
    try {
      apiKey = await this.options.client.resolveAPIKey(job.telegramUserId, job.model);
      const images = await downloadTelegramImages(this.options.api, this.options.botToken, inputs);
      let taskId: string;
      if (job.type === "video_generate") {
        const durationSeconds = numberOption(job.options.durationSeconds, 4);
        const aspectRatio = stringOption(job.options.aspectRatio, "16:9");
        const resolution = stringOption(job.options.resolution, "768P");
        taskId = await this.options.client.submitVideo(apiKey, {
          model: job.model,
          prompt: job.instruction,
          durationSeconds,
          aspectRatio,
          resolution,
          images: images.map((image, index) => ({
            dataUrl: dataUrl(image),
            role: index === 0 ? "first_frame" : index === 1 ? "last_frame" : "reference_image",
          })),
        });
      } else {
        const aspectRatio = stringOption(job.options.aspectRatio, "1:1");
        if (aspectRatio !== "1:1" && aspectRatio !== "16:9" && aspectRatio !== "9:16") {
          throw new Error("invalid_image_aspect_ratio");
        }
        taskId = await this.options.client.submitImage(apiKey, job.model, job.instruction, aspectRatio, images);
      }
      this.options.store.transitionJob(job.id, ["submitting"], "submitted", { upstreamTaskId: taskId });
      this.options.debug?.finish(debugId, {
        status: "submitted",
        taskId,
        responsePreview: { status: "submitted" },
        details: { mediaJobId: job.id, phase: "polling" },
      });
      if (!hasEphemeralStatus(job)) {
        await this.updateStatus(job, botText(mediaJobLocale(job.options), "submitted"));
      }
    } catch (error) {
      this.options.store.transitionJob(job.id, ["submitting"], "failed", { errorCode: errorCode(error) });
      this.options.debug?.finish(debugId, { status: "failed", errorCode: errorCode(error) });
      await this.notifyFailure(job, botText(mediaJobLocale(job.options), "submissionFailed"));
    }
  }

  private async poll(job: MediaJob): Promise<void> {
    if (!job.upstreamTaskId) return;
    const apiKey = await this.options.client.resolveAPIKey(job.telegramUserId, job.model);
    const state = job.type === "video_generate"
      ? await this.options.client.pollVideo(apiKey, job.upstreamTaskId)
      : await this.options.client.pollImage(apiKey, job.model, job.upstreamTaskId);
    if (state.status === "failed") {
      this.options.store.transitionJob(job.id, [job.status], "failed", { errorCode: state.errorCode ?? "generation_failed" });
      this.finishMediaTrace(job, state, "failed");
      await this.notifyFailure(job, botText(mediaJobLocale(job.options), "generationFailed"));
      return;
    }
    if (state.status === "succeeded") {
      await this.deliver(job, apiKey, state);
      this.finishMediaTrace(job, state, "succeeded");
      return;
    }
    if (job.status === "submitted") {
      this.options.store.transitionJob(job.id, ["submitted"], "in_progress", { progress: state.progress });
    } else if (state.progress !== null && state.progress !== job.progress) {
      // Keep the legal state transition model simple: progress persistence is
      // best effort through an in_progress self update only when supported later.
      const progress = state.progress === null ? "" : ` (${state.progress}%)`;
      await this.updateStatus(job, botText(mediaJobLocale(job.options), "stillProcessing", { progress }));
    }
  }

  private finishMediaTrace(job: MediaJob, state: NormalizedTaskStatus, status: "succeeded" | "failed"): void {
    const id = this.options.debug?.start({
      telegramUserId: job.telegramUserId,
      chatId: job.chatId,
      chatType: job.chatId === job.telegramUserId ? "private" : "group",
      messageId: job.requestMessageId,
      kind: job.type,
      model: job.model,
      requestPreview: { instruction: job.instruction, options: job.options },
      details: { mediaJobId: job.id, phase: "completed" },
      taskId: job.upstreamTaskId,
      externalKey: `media-job:${job.id}`,
    }) ?? null;
    this.options.debug?.finish(id, {
      status,
      taskId: job.upstreamTaskId,
      errorCode: state.errorCode,
      responsePreview: {
        status: state.status,
        progress: state.progress,
        result: state.resultUrl ? "protected upstream result" : state.resultBase64 ? "base64 result omitted" : null,
      },
      details: { mediaJobId: job.id, phase: "completed" },
    });
  }

  private async deliver(job: MediaJob, apiKey: string, state: NormalizedTaskStatus): Promise<void> {
    const locale = mediaJobLocale(job.options);
    let media;
    if (state.resultBase64) {
      media = { bytes: new Uint8Array(Buffer.from(state.resultBase64, "base64")), mimeType: "image/png", filename: "mia-image.png" };
      if (media.bytes.byteLength > this.options.resultMaxBytes) throw new Error("content_too_large");
      this.options.store.saveLocalResult(job.id, media.bytes);
    } else if (state.resultUrl) {
      try {
        media = await this.options.client.getContent(apiKey, state.resultUrl, this.options.resultMaxBytes);
      } catch (error) {
        if (job.type === "video_generate" && errorCode(error) === "content_too_large" && this.options.publicBaseUrl) {
          const token = this.options.store.createAccessToken("download", job.id);
          await this.options.api.sendMessage(job.chatId, botText(locale, "videoReadyLink", {
            url: `${this.options.publicBaseUrl}/mia/media/download/${token.token}`,
          }), replyOptions(job));
          this.options.store.transitionJob(job.id, [job.status], "succeeded", {
            progress: 100,
            resultUrl: state.resultUrl,
            resultMimeType: "video/mp4",
          });
          return;
        }
        throw error;
      }
    } else {
      throw new Error("missing_media_result");
    }
    const input = new InputFile(media.bytes, media.filename);
    const keyboard = new InlineKeyboard()
      .text(botText(locale, job.type === "video_generate" ? "generateAgain" : "generateAnother"), `media:${job.id}:again`)
      .text(botText(locale, "continueEditing"), `media:${job.id}:edit`).row();
    if (this.options.publicBaseUrl) {
      const token = this.options.store.createAccessToken("download", job.id);
      keyboard.url(botText(locale, "downloadOriginal"), `${this.options.publicBaseUrl}/mia/media/download/${token.token}`);
    } else {
      // Keep callback downloads working in private/dev deployments without a
      // browser-reachable Mia URL, and for messages created before this change.
      keyboard.text(botText(locale, "downloadOriginal"), `media:${job.id}:download`);
    }
    let sent;
    if (job.type === "video_generate" && media.mimeType.startsWith("video/")) {
      try {
        sent = await this.options.api.sendVideo(job.chatId, input, {
          ...replyOptions(job), caption: botText(locale, "videoReady"), reply_markup: keyboard,
        });
      } catch {
        sent = await this.options.api.sendDocument(job.chatId, input, {
          ...replyOptions(job), caption: botText(locale, "videoReady"), reply_markup: keyboard,
        });
      }
    } else {
      try {
        sent = await this.options.api.sendPhoto(job.chatId, input, {
          ...replyOptions(job), caption: botText(locale, "imageReady"), reply_markup: keyboard,
        });
      } catch {
        sent = await this.options.api.sendDocument(job.chatId, input, {
          ...replyOptions(job), caption: botText(locale, "imageReady"), reply_markup: keyboard,
        });
      }
    }
    const file = "video" in sent && sent.video ? sent.video : "photo" in sent && sent.photo ? sent.photo.at(-1) : "document" in sent ? sent.document : undefined;
    if (job.type !== "video_generate" && file) {
      this.options.store.saveTelegramMedia(job.chatId, job.threadId, {
        position: 0,
        messageId: sent.message_id,
        fileId: file.file_id,
        fileUniqueId: file.file_unique_id,
        type: "document" in sent ? "document" : "photo",
        mimeType: media.mimeType,
        mediaGroupId: null,
      });
    }
    if (job.type !== "video_generate" && job.chatId === job.telegramUserId && file) {
      this.options.store.setActivePrivateImage({
        telegramUserId: job.telegramUserId,
        chatId: job.chatId,
        messageId: sent.message_id,
        fileId: file.file_id,
        fileUniqueId: file.file_unique_id,
        type: "document" in sent ? "document" : "photo",
        mimeType: media.mimeType,
        mediaGroupId: null,
      });
    }
    if (hasEphemeralStatus(job) && job.statusMessageId) {
      await this.options.api.deleteMessage(job.chatId, job.statusMessageId).catch(() => undefined);
    }
    this.options.store.transitionJob(job.id, [job.status], "succeeded", {
      statusMessageId: sent.message_id,
      progress: 100,
      resultUrl: state.resultUrl,
      resultMimeType: media.mimeType,
      resultTelegramFileId: file?.file_id ?? null,
      resultTelegramUniqueId: file?.file_unique_id ?? null,
    });
  }

  private async notifyFailure(job: MediaJob, text: string): Promise<void> {
    if (hasEphemeralStatus(job) && job.statusMessageId) {
      const edited = await this.options.api.editMessageText(job.chatId, job.statusMessageId, text, {
        reply_markup: { inline_keyboard: [] },
      }).then(() => true).catch(() => false);
      if (edited) return;
    }
    await this.options.api.sendMessage(job.chatId, text, replyOptions(job)).catch(() => undefined);
  }

  private async updateStatus(job: MediaJob, text: string): Promise<void> {
    if (job.statusMessageId) {
      await this.options.api.editMessageText(job.chatId, job.statusMessageId, text).catch(() => undefined);
    }
  }
}

function hasEphemeralStatus(job: MediaJob): boolean {
  return job.options.ephemeralStatus === true;
}

function replyOptions(job: MediaJob) {
  return {
    reply_parameters: { message_id: job.requestMessageId, allow_sending_without_reply: true },
    ...(job.threadId === null ? {} : { message_thread_id: job.threadId }),
  };
}

function stringOption(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function numberOption(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "media_request_failed";
}
