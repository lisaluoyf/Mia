import { GrammyError, InlineKeyboard, InputFile, type Api } from "grammy";
import type { InputRichMessage, Message, Update } from "grammy/types";
import type { Logger } from "pino";
import type { APIMasterClient } from "../clients/apimaster.js";
import type { ChatCredentialProvider } from "../credentials/chat.js";
import { withGuestTextRequestFallback } from "../credentials/chat.js";
import type { ModelSettingsService } from "../settings/service.js";
import type { MediaStore } from "../media/store.js";
import type { MediaJob } from "../media/types.js";
import type { ContextStore } from "../storage/store.js";
import type { ConversationScope } from "../storage/types.js";
import { loadConversationContext } from "../context/conversation.js";
import type { DebugContextLayers } from "../debug/types.js";
import type { DebugRecorder } from "../debug/recorder.js";
import { isStickerSetNameOccupied, stickerSetName } from "../stickers/service.js";
import type { AgentStore } from "./store.js";
import { AgentRuntime, instructions } from "./runtime.js";
import { AgentModelError, responseStep } from "./model.js";
import { createAgentTools } from "./tools.js";
import { sendAgentChunk, formatRejected } from "./presentation.js";
import { miaResponseFromText } from "../presentation/schema.js";
import { renderTelegramRich } from "../presentation/telegram-rich.js";
import { scopeKey, type AgentInput, type Operation, type Run } from "./types.js";
import { promptReference, promptText } from "../prompts.js";
import { mediaExecutionFeedback } from "../media/execution-feedback.js";
import { draftKeyboard, videoDraftText } from "../telegram/video-draft.js";

interface ServiceOptions {
  store: AgentStore; media: MediaStore; client: APIMasterClient; settings: ModelSettingsService;
  credentials: ChatCredentialProvider; contexts: ContextStore; logger: Logger;
  botToken: string; baseUrl: string; model: () => string; timeoutMs: number;
  enabled: boolean; webSearch: boolean;
  debug?: DebugRecorder;
}

const RICH_PROGRESS_ANIMATION_MS = 450;
const RICH_PROGRESS_LABELS = ["Thinking", "Reasoning", "Cooking", "Checking"] as const;

function richProgressMessage(frame: number): InputRichMessage {
  return {
    blocks: [
      { type: "paragraph", text: RICH_PROGRESS_LABELS[Math.floor(frame / 3) % RICH_PROGRESS_LABELS.length] ?? "Thinking" },
      { type: "paragraph", text: ".".repeat(frame % 3 + 1) },
    ],
  };
}

interface ProgressMessageState {
  chatId: number;
  messageId: number;
  timer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  stopped: boolean;
}

export class AgentService {
  private runtime: AgentRuntime | null = null;
  private api: Api | null = null;
  private botId = 0;
  private botUsername = "";
  private ingressTimer: NodeJS.Timeout | null = null;
  private ingressWork: Promise<void> | null = null;
  private lastPrunedAt = 0;
  private readonly debugIds = new Map<string, string | null>();
  private readonly progressMessages = new Map<string, ProgressMessageState>();
  constructor(private readonly options: ServiceOptions) {}
  enabled(userId: number): boolean {
    void userId;
    return this.options.enabled;
  }
  canSubmit(job: MediaJob): boolean {
    if (typeof job.options.agentRunId !== "string") return false;
    const run = this.options.store.get(job.options.agentRunId);
    if (!run || run.status === "cancelled") return false;
    const operation = run.operations.find(op => op.id === job.options.agentOperationId);
    if (!operation || operation.revision !== run.revision) return false;
    // Images can be submitted as the first paid operation without an explicit
    // confirmation. Video drafts are the only media path that must be approved.
    if (job.type === "video_generate" && !operation.approved) return false;
    // The originating Telegram message may still be visible to the durable
    // inbox while its Agent operation is being claimed. It is not a newer
    // instruction and must not cancel its own media submission.
    return !this.options.store.inputs().some(input =>
      scopeKey(input) === run.scope && input.messageId !== job.requestMessageId,
    );
  }
  ownsUpdate(update: Update): boolean {
    const from = update.message?.from ?? update.callback_query?.from;
    return Boolean(from && this.enabled(from.id));
  }
  enqueueUpdate(update: Update): boolean {
    if (!this.ownsUpdate(update)) return false;
    this.options.store.enqueueUpdate(update);
    return true;
  }
  attach(api: Api, botId: number, botUsername: string): void {
    this.api = api;
    this.botId = botId;
    this.botUsername = botUsername;
    this.runtime = new AgentRuntime({
      store: this.options.store,
      tools: createAgentTools({ ...this.options, api }),
      logger: this.options.logger,
      model: async (run, input, tools, signal) => {
        const selected = this.options.settings.getPreferences(run.input.userId).chatModel ?? this.options.model();
        const credential = await this.options.credentials.resolve(run.input.userId, selected);
        this.startDebug(run, credential.model);
        const request = (current: typeof credential) => responseStep({
          baseUrl: this.options.baseUrl, apiKey: current.apiKey, model: current.model,
          instructions: `${promptText("mia.system", run.input.language)}\n\n${instructions}`,
          // A guest credential only plans the task. Media tools independently resolve the
          // Telegram user's credential before they can create a billable media job.
          input, tools, signal, timeoutMs: this.options.timeoutMs,
          webSearch: this.options.webSearch,
          onProgress: phase => this.progress(run, phase, () => !signal.aborted && this.options.store.get(run.id)?.revision === run.revision),
        });
        try {
          return (await withGuestTextRequestFallback(this.options.credentials, credential, request)).value;
        } catch (error) {
          this.finishDebug(run, "failed", { phase: "model_request" }, error instanceof AgentModelError ? error.code : "model_request_failed");
          throw error;
        }
      },
      notify: run => this.notify(run),
      deliver: (run, current) => this.deliver(run, current),
    });
  }
  start(handleUpdate: (update: Update) => Promise<void>): void {
    this.runtime?.start();
    const tick = () => {
      if (this.ingressWork) return;
      this.ingressWork = (async () => {
        if (Date.now() - this.lastPrunedAt > 3600_000) {
          this.options.store.prune();
          this.lastPrunedAt = Date.now();
        }
        for (const update of this.options.store.updates()) {
          try {
            await handleUpdate(update);
            this.options.store.consumeUpdate(update.update_id);
          } catch {
            this.options.logger.warn({ updateId: update.update_id }, "Agent inbox update retained for retry");
          }
        }
      })().finally(() => { this.ingressWork = null; });
    };
    this.ingressTimer = setInterval(tick, 500);
    this.ingressTimer.unref();
    tick();
  }
  async stop(): Promise<void> {
    if (this.ingressTimer) clearInterval(this.ingressTimer);
    this.ingressTimer = null;
    if (this.api) {
      await Promise.all([...this.progressMessages.entries()].map(async ([key, progress]) => {
        this.progressMessages.delete(key);
        progress.stopped = true;
        if (progress.timer) clearInterval(progress.timer);
        await progress.inFlight;
        await this.api!.deleteMessage(progress.chatId, progress.messageId).catch(() => undefined);
      }));
    }
    this.progressMessages.clear();
    await this.ingressWork;
    await this.runtime?.stop();
  }
  async drain(): Promise<void> { await this.runtime?.drain(); }
  enqueue(input: Omit<AgentInput, "context">): void {
    if (!this.runtime) throw new Error("Agent runtime is not attached");
    const scope: ConversationScope = input.chatId === input.userId ? { type: "private", chatId: input.chatId } : input.threadId === null ? { type: "group", chatId: input.chatId } : { type: "topic", chatId: input.chatId, threadId: input.threadId };
    const context = loadConversationContext({
      store: this.options.contexts,
      scope,
      userId: input.userId,
      currentMessageId: input.messageId,
      replyToMessageId: input.replyToMessageId,
      metadata: {
        chatType: scope.type === "private" ? "private" : "group",
        chatTitle: null,
        currentUser: String(input.userId),
        language: input.language,
        currentTime: new Date().toISOString(),
        timezone: null,
        trigger: input.replyToMessageId === null ? "message" : "reply",
        currentTask: null,
      },
    }, this.botId);
    this.runtime.enqueue({
      ...input,
      context: JSON.stringify({
        summary: context.summary,
        memories: context.memories.map(memory => ({
          scope: memory.scope.type,
          category: memory.category,
          content: memory.content,
          sourceMessageId: memory.sourceMessageId,
        })),
        messages: context.messages.map(message => ({
          sender: message.senderUserId,
          text: message.text ?? message.caption,
          id: message.messageId,
          replyToMessageId: message.replyToMessageId,
          sentAt: message.sentAt,
        })),
      }),
    });
  }
  cancel(input: Pick<AgentInput, "userId" | "chatId" | "threadId">): void { this.runtime?.cancelScope(scopeKey(input)); }
  approve(id: string, revision: number, userId: number, chatId: number, threadId: number | null): boolean {
    return this.runtime?.approve(id, revision, userId, chatId, threadId) ?? false;
  }
  approveVideoDraft(job: MediaJob, userId: number): "approved" | "changed" | "limit_reached" {
    const runId = typeof job.options.agentRunId === "string" ? job.options.agentRunId : null;
    const operationId = typeof job.options.agentOperationId === "string" ? job.options.agentOperationId : null;
    const revision = typeof job.options.agentRevision === "number" ? job.options.agentRevision : null;
    if (!runId || !operationId || revision === null || job.telegramUserId !== userId || job.status !== "draft") return "changed";
    const run = this.options.store.get(runId);
    const operation = run?.operations.find(op => op.id === operationId);
    if (!run || run.revision !== revision || run.status !== "waiting_approval" || operation?.state !== "approval" || operation.draftJobId !== job.id) return "changed";

    let result: "changed" | "limit_reached" | "approved" = "changed";
    const approved = this.runtime?.approve(run.id, revision, userId, job.chatId, job.threadId, () => {
      const claimed = this.options.media.claimDraft(job.id);
      if (claimed.outcome === "limit_reached") {
        result = "limit_reached";
        return false;
      }
      if (claimed.outcome !== "claimed") return false;
      result = "approved";
      return true;
    }) ?? false;
    return approved ? "approved" : result;
  }
  cancelVideoDraft(job: MediaJob, userId: number, key: string): boolean {
    const runId = typeof job.options.agentRunId === "string" ? job.options.agentRunId : null;
    if (!runId || job.telegramUserId !== userId) return false;
    return this.cancelRun(runId, userId, job.chatId, job.threadId, key);
  }
  private keyboard(run: Run): InlineKeyboard | null {
    if (run.status !== "waiting_approval") return null;
    const keyboard = new InlineKeyboard();
    keyboard.text(run.input.language.startsWith("zh") ? "确认执行" : "Confirm", `agent:${run.id}:${run.revision}:approve`);
    return keyboard;
  }
  private editReplyMarkup(run: Run): InlineKeyboard | { inline_keyboard: [] } {
    // Explicitly clear an approval control when the task message changes state.
    return this.keyboard(run) ?? { inline_keyboard: [] };
  }
  cancelRun(id: string, userId: number, chatId: number, threadId: number | null, key: string): boolean {
    const run = this.options.store.get(id);
    if (!run || run.input.userId !== userId || run.input.chatId !== chatId || run.input.threadId !== threadId || ["completed", "cancelled"].includes(run.status)) return false;
    this.runtime?.enqueue({ ...run.input, key, text: "/cancel", media: [] });
    return true;
  }
  private replyOptions(run: Run): { message_thread_id?: number; reply_parameters?: { message_id: number; allow_sending_without_reply: boolean } } {
    const replyToMessageId = run.input.chatId === run.input.userId
      ? run.input.replyToMessageId
      : run.input.messageId;
    return {
      ...(run.input.threadId === null ? {} : { message_thread_id: run.input.threadId }),
      ...(replyToMessageId === null ? {} : { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }),
    };
  }
  private async notify(run: Run): Promise<number | null> {
    if (!this.api || !run.notice) return null;
    await this.clearDraft(run);
    const draftOperation = run.status === "waiting_approval"
      ? run.operations.find(op => op.state === "approval" && op.call.name === "generate_video" && op.draftJobId)
      : null;
    const draft = draftOperation?.draftJobId ? this.options.media.getJob(draftOperation.draftJobId) : null;
    if (draft && draft.status === "draft" && draft.options.agentRevision === run.revision) {
      try {
        if (run.noticeMessageId) {
          await this.api.editMessageText(run.input.chatId, run.noticeMessageId, videoDraftText(draft), { reply_markup: draftKeyboard(draft) });
          this.options.media.updateDraft(draft.id, draft.options, run.noticeMessageId);
          return run.noticeMessageId;
        }
        const sent = await this.api.sendMessage(run.input.chatId, videoDraftText(draft), {
          ...this.replyOptions(run), reply_markup: draftKeyboard(draft),
        });
        this.options.media.updateDraft(draft.id, draft.options, sent.message_id);
        return sent.message_id;
      } catch {
        return null;
      }
    }
    const key = `${run.id}:notice:${run.noticeVersion}`;
    const existing = this.options.store.delivery(key);
    if (existing?.status === "delivered") return existing.message_id;
    if (run.noticeMessageId) {
      // Rich progress messages cannot be reliably converted with editMessageText.
      // Replace them so both progress and final responses remain visible.
      await this.api.deleteMessage(run.input.chatId, run.noticeMessageId).catch(() => undefined);
      run.noticeMessageId = null;
    }
    if (existing) return null;
    this.options.store.setDelivery(key, "sending");
    try {
      let sent: Message;
      const keyboard = this.keyboard(run);
      const options = { ...this.replyOptions(run), ...(keyboard ? { reply_markup: keyboard } : {}) };
      try {
        sent = await this.api.sendRichMessage(run.input.chatId, renderTelegramRich(miaResponseFromText(run.notice))[0]!.richMessage, options);
      } catch (error) {
        if (!formatRejected(error)) throw error;
        sent = await this.api.sendMessage(run.input.chatId, run.notice, options);
      }
      this.options.store.setDelivery(key, "delivered", sent.message_id);
      return sent.message_id;
    } catch {
      this.options.store.setDelivery(key, "outcome_unknown");
      return null;
    }
  }
  private async progress(run: Run, phase: "started" | "receiving", current: () => boolean): Promise<void> {
    if (!this.api || !current() || phase !== "started") return;
    if (run.input.chatId === run.input.userId) {
      await this.startDraft(run, current);
      return;
    }
    try {
      await this.api.sendChatAction(run.input.chatId, "typing", run.input.threadId === null ? {} : { message_thread_id: run.input.threadId });
    } catch {
      // Typing is best-effort and must not delay the response.
    }
  }
  private draftKey(run: Run): string { return `${run.id}:${run.revision}`; }
  private async clearDraft(run: Run): Promise<void> {
    const prefix = `${run.id}:`;
    const pending: Promise<unknown>[] = [];
    for (const [key, progress] of this.progressMessages) {
      if (!key.startsWith(prefix)) continue;
      this.progressMessages.delete(key);
      progress.stopped = true;
      if (progress.timer) clearInterval(progress.timer);
      pending.push((async () => {
        await progress.inFlight;
        await this.api?.deleteMessage(progress.chatId, progress.messageId).catch(() => undefined);
      })());
    }
    await Promise.all(pending);
  }
  private async startDraft(run: Run, current: () => boolean): Promise<void> {
    const api = this.api;
    if (!api) return;
    const key = this.draftKey(run);
    if (this.progressMessages.has(key) || !current()) return;
    try {
      const sent = await api.sendRichMessage(run.input.chatId, richProgressMessage(0), run.input.threadId === null ? {} : { message_thread_id: run.input.threadId });
      let frame = 0;
      const state: ProgressMessageState = {
        chatId: run.input.chatId,
        messageId: sent.message_id,
        timer: null,
        inFlight: null,
        stopped: false,
      };
      state.timer = setInterval(() => {
        if (state.stopped || state.inFlight) return;
        frame += 1;
        const update = api.editMessageText(state.chatId, state.messageId, richProgressMessage(frame))
          .then(() => undefined)
          .catch(() => undefined)
          .finally(() => {
            if (state.inFlight === update) state.inFlight = null;
          });
        state.inFlight = update;
      }, RICH_PROGRESS_ANIMATION_MS);
      state.timer.unref();
      this.progressMessages.set(key, state);
    } catch {
      await api.sendChatAction(run.input.chatId, "typing").catch(() => undefined);
    }
  }
  private async sendOnce(key: string, send: () => Promise<Message>): Promise<void> {
    const existing = this.options.store.delivery(key);
    if (existing?.status === "delivered") return;
    if (existing?.status === "format_rejected") throw new GrammyError("Persisted format rejection", { ok: false, error_code: 400, description: "Unsupported presentation format" }, "sendMessage", {});
    if (existing && existing.status !== "failed") throw new AgentModelError("delivery_outcome_unknown", false);
    this.options.store.setDelivery(key, "sending");
    try {
      const sent = await send();
      this.options.store.setDelivery(key, "delivered", sent.message_id);
    } catch (error) {
      const rejected = error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500;
      this.options.store.setDelivery(key, formatRejected(error) ? "format_rejected" : rejected || error instanceof AgentModelError ? "failed" : "outcome_unknown");
      if (formatRejected(error)) throw error;
      throw new AgentModelError(rejected ? "telegram_delivery_rejected" : error instanceof AgentModelError ? error.code : "delivery_outcome_unknown", false);
    }
  }
  private mediaCaption(run: Run, operation: Operation): string {
    const zh = run.input.language.startsWith("zh");
    if (operation.call.name === "generate_video") return zh ? "视频已生成。" : "Video generated.";
    if (operation.call.name === "create_sticker") return zh ? "贴纸已创建。" : "Sticker created.";
    if (operation.call.name === "edit_image") return zh ? "图片已编辑完成。" : "Image edited.";
    return zh ? "图片已生成。" : "Image generated.";
  }
  private async deliver(run: Run, current: () => boolean): Promise<void> {
    const api = this.api;
    if (!api || !run.final) return;
    await this.clearDraft(run);
    if (run.final.executionBlock) {
      const feedback = mediaExecutionFeedback(run.final.executionBlock, run.input.language);
      const message = renderTelegramRich(miaResponseFromText(feedback.text))[0]!;
      await this.sendOnce(`${run.id}:media-block:${run.final.revision}:${run.final.executionBlock}`, async () => {
        const options = { ...this.replyOptions(run), reply_markup: feedback.keyboard };
        try {
          // A native Rich Message completes and clears the active Rich Draft.
          return await api.sendRichMessage(run.input.chatId, message.richMessage, options);
        } catch (error) {
          if (!formatRejected(error)) throw error;
          return api.sendMessage(run.input.chatId, feedback.text, options);
        }
      });
      this.finishDebug(run, "failed", { phase: "media_execution_blocked", reason: run.final.executionBlock });
      return;
    }
    const completedArtifacts = run.operations.filter((operation) => operation.result?.artifact);
    for (const op of run.operations) {
      if (!current()) return;
      const artifact = op.result?.artifact;
      if (!artifact) continue;
      const job = this.options.media.getJob(artifact.jobId);
      if (!job || job.telegramUserId !== run.input.userId || job.chatId !== run.input.chatId || job.threadId !== run.input.threadId) throw new AgentModelError("artifact_unavailable", false);
      await this.sendOnce(`${run.id}:artifact:${job.id}`, async () => {
        const local = this.options.media.readLocalResult(job.id, job.resultMimeType);
        if (!local) throw new AgentModelError("artifact_expired", false);
        const file = new InputFile(local.bytes, local.filename);
        let sent: Message;
        if (job.options.outputMode === "telegram_sticker") {
          const name = stickerSetName(run.input.userId, job.id, this.botUsername);
          try {
            await api.createNewStickerSet(run.input.userId, name, "Mia Sticker", [{ sticker: file, format: "static", emoji_list: ["\u2728"] }]);
          } catch (error) { if (!isStickerSetNameOccupied(error)) throw error; }
          const set = await api.getStickerSet(name);
          const sticker = set.stickers[0];
          if (!sticker) throw new Error("empty_sticker_set");
          if (!current()) throw new AgentModelError("delivery_superseded", false);
          sent = await api.sendSticker(run.input.chatId, sticker.file_id, { ...this.replyOptions(run), reply_markup: new InlineKeyboard().url("Sticker pack", `https://t.me/addstickers/${name}`) });
        } else if (artifact.kind === "video") sent = await api.sendVideo(run.input.chatId, file, { ...this.replyOptions(run), caption: this.mediaCaption(run, op) });
        else sent = await api.sendDocument(run.input.chatId, file, { ...this.replyOptions(run), caption: this.mediaCaption(run, op) });
        const mediaFile = "document" in sent ? sent.document : "video" in sent ? sent.video : "sticker" in sent ? sent.sticker : null;
        this.options.media.recordAgentDelivery(job.id, sent.message_id, mediaFile?.file_id ?? null, mediaFile?.file_unique_id ?? null);
        if (artifact.kind === "image" && mediaFile && job.options.outputMode !== "telegram_sticker") {
          const ref = { messageId: sent.message_id, fileId: mediaFile.file_id, fileUniqueId: mediaFile.file_unique_id, type: "document" as const, mimeType: local.mimeType, mediaGroupId: null };
          this.options.media.saveTelegramMedia(run.input.chatId, run.input.threadId, { ...ref, position: 0 });
          if (run.input.chatId === run.input.userId) this.options.media.setActivePrivateImage({ ...ref, telegramUserId: run.input.userId, chatId: run.input.chatId });
        }
        return sent;
      });
    }
    if (!current()) return;
    const answerKey = `${run.id}:answer:${run.final.revision}:${run.operations.length}:${run.steps}`;
    const oldDelivery = this.options.store.delivery(answerKey);
    if (oldDelivery?.status === "delivered") return;
    if (oldDelivery && oldDelivery.status !== "failed") throw new AgentModelError("delivery_outcome_unknown", false);
    // Media is the result. Do not follow it with a model-authored recap or table.
    if (run.final.status === "completed" && completedArtifacts.length > 0) {
      if (run.noticeMessageId) {
        await api.deleteMessage(run.input.chatId, run.noticeMessageId).catch(() => undefined);
        run.noticeMessageId = null;
        run.notice = null;
      }
      this.options.store.setDelivery(answerKey, "delivered");
      this.finishDebug(run, "succeeded", { phase: "media_delivered", completedArtifacts: completedArtifacts.map(operation => operation.id) });
      return;
    }
    const presentation = miaResponseFromText(run.final.text);
    const chunks = renderTelegramRich(presentation);
    if (run.noticeMessageId) {
      // The final answer must be a fresh Telegram message. Editing a native Rich
      // Message through editMessageText can report success without replacing it.
      await api.deleteMessage(run.input.chatId, run.noticeMessageId).catch(() => undefined);
      run.noticeMessageId = null;
      run.notice = null;
    }
    for (const [index, chunk] of chunks.entries()) {
      if (!current()) return;
      const chunkKey = `${answerKey}:chunk:${index}`;
      if (this.options.store.delivery(chunkKey)?.status === "delivered") continue;
      await sendAgentChunk(api, run.input.chatId, chunk, this.replyOptions(run), (suffix, send) => this.sendOnce(`${chunkKey}:${suffix}`, async () => {
      const sent = await send();
      this.options.contexts.upsertUser({ telegramUserId: this.botId, firstName: "Mia", lastName: null, username: this.botUsername, languageCode: null, isBot: true });
      this.options.contexts.saveMessage({ chatId: run.input.chatId, messageId: sent.message_id, threadId: run.input.threadId, senderUserId: this.botId, senderChatId: null, replyToMessageId: run.input.messageId, contentType: "rich_message" in sent ? "rich_message" : "text", text: chunk.plainText, caption: null, entitiesJson: null, mediaFileId: null, mediaUniqueId: null, sentAt: new Date(sent.date * 1000).toISOString(), editedAt: null });
      return sent;
      }), current);
      if (!current()) return;
      this.options.store.setDelivery(chunkKey, "delivered");
    }
    this.options.store.setDelivery(answerKey, "delivered");
    this.finishDebug(run, "succeeded", {
      phase: "telegram_delivered",
      delivery: { mode: "rich_message", chunkCount: chunks.length, richMessages: chunks.map(chunk => chunk.richMessage) },
    });
  }

  private debugKey(run: Run): string {
    return `${run.id}:${run.revision}`;
  }

  private debugContext(run: Run): DebugContextLayers {
    let stored: { summary?: unknown; memories?: unknown; messages?: unknown } = {};
    try {
      const parsed: unknown = JSON.parse(run.input.context);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        stored = { summary: record.summary, memories: record.memories, messages: record.messages };
      }
    } catch {
      // The trace remains useful even when an older persisted run has no JSON context.
    }
    return {
      systemRules: { prompts: [promptReference("mia.system")], runtime: "agent.runtime" },
      conversation: { scope: run.scope, chatId: run.input.chatId, threadId: run.input.threadId, messageId: run.input.messageId },
      longTermMemory: stored.memories ?? [],
      rollingSummary: stored.summary ?? null,
      recentMessages: stored.messages ?? [],
    };
  }

  private startDebug(run: Run, model: string): string | null {
    const key = this.debugKey(run);
    const existing = this.debugIds.get(key);
    if (existing !== undefined) return existing;
    const id = this.options.debug?.start({
      telegramUserId: run.input.userId,
      chatId: run.input.chatId,
      chatType: run.input.chatId === run.input.userId ? "private" : "group",
      messageId: run.input.messageId,
      kind: "agent_loop",
      model,
      promptRefs: [promptReference("mia.system")],
      contextLayers: this.debugContext(run),
      requestPreview: { text: run.input.text, replyToMessageId: run.input.replyToMessageId, media: run.input.media.map(media => ({ messageId: media.messageId, type: media.type, mimeType: media.mimeType })) },
      details: { phase: "agent_run", runId: run.id, revision: run.revision, runtimeInstruction: "agent.runtime" },
      externalKey: `agent:${key}`,
    }) ?? null;
    this.debugIds.set(key, id);
    return id;
  }

  private finishDebug(run: Run, status: "succeeded" | "failed", details: Record<string, unknown>, errorCode?: string): void {
    const id = this.startDebug(run, this.options.model());
    this.options.debug?.finish(id, {
      status,
      responsePreview: run.final ? { status: run.final.status, text: run.final.text } : null,
      details: { ...details, runId: run.id, revision: run.revision, operations: run.operations.map(operation => ({ id: operation.id, tool: operation.call.name, state: operation.state, result: operation.result?.status ?? null })) },
      ...(errorCode ? { errorCode } : {}),
    });
  }
}
