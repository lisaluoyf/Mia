import { GrammyError, InlineKeyboard, InputFile, type Api } from "grammy";
import type { Message, Update } from "grammy/types";
import type { Logger } from "pino";
import type { APIMasterClient } from "../clients/apimaster.js";
import type { ChatCredentialProvider } from "../credentials/chat.js";
import type { ModelSettingsService } from "../settings/service.js";
import type { MediaStore } from "../media/store.js";
import type { MediaJob } from "../media/types.js";
import type { ContextStore } from "../storage/store.js";
import type { ConversationScope } from "../storage/types.js";
import { isStickerSetNameOccupied, stickerSetName } from "../stickers/service.js";
import type { AgentStore } from "./store.js";
import { AgentRuntime, instructions } from "./runtime.js";
import { AgentModelError, responseStep } from "./model.js";
import { createAgentTools } from "./tools.js";
import { scopeKey, type AgentInput, type Run } from "./types.js";

interface ServiceOptions {
  store: AgentStore; media: MediaStore; client: APIMasterClient; settings: ModelSettingsService;
  credentials: ChatCredentialProvider; contexts: ContextStore; logger: Logger;
  botToken: string; baseUrl: string; model: () => string; timeoutMs: number;
  enabled: boolean; allowedUsers: number[]; webSearch: boolean;
}
export class AgentService {
  private runtime: AgentRuntime | null = null;
  private api: Api | null = null;
  private botId = 0;
  private botUsername = "";
  private ingressTimer: NodeJS.Timeout | null = null;
  private ingressWork: Promise<void> | null = null;
  private lastPrunedAt = 0;
  constructor(private readonly options: ServiceOptions) {}
  enabled(userId: number): boolean { return this.options.enabled && this.options.allowedUsers.includes(userId); }
  canSubmit(job: MediaJob): boolean {
    if (typeof job.options.agentRunId !== "string") return false;
    const run = this.options.store.get(job.options.agentRunId);
    if (!run || run.status === "cancelled") return false;
    const operation = run.operations.find(op => op.id === job.options.agentOperationId);
    if (!operation || operation.revision !== run.revision) return false;
    return !this.options.store.inputs().some(input => scopeKey(input) === run.scope);
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
        const permittedTools = credential.source === "user" ? tools : tools.filter(tool => ["finish", "read_conversation"].includes(tool.name));
        return responseStep({ baseUrl: this.options.baseUrl, apiKey: credential.apiKey, model: credential.model, instructions, input, tools: permittedTools, signal, timeoutMs: this.options.timeoutMs });
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
    await this.ingressWork;
    await this.runtime?.stop();
  }
  async drain(): Promise<void> { await this.runtime?.drain(); }
  enqueue(input: Omit<AgentInput, "context">): void {
    if (!this.runtime) throw new Error("Agent runtime is not attached");
    const scope: ConversationScope = input.chatId === input.userId ? { type: "private", chatId: input.chatId } : input.threadId === null ? { type: "group", chatId: input.chatId } : { type: "topic", chatId: input.chatId, threadId: input.threadId };
    const recent = this.options.contexts.listRecentMessages(scope, 30);
    const summary = this.options.contexts.getLatestSummary(scope)?.content;
    const memories = this.options.contexts.listMemories(scope.type === "private" ? { type: "user", userId: input.userId } : scope, 30);
    const context = JSON.stringify({ summary, memories, messages: recent.map(message => ({ sender: message.senderUserId, text: message.text ?? message.caption, id: message.messageId })) });
    this.runtime.enqueue({ ...input, context });
  }
  cancel(input: Pick<AgentInput, "userId" | "chatId" | "threadId">): void { this.runtime?.cancelScope(scopeKey(input)); }
  approve(id: string, revision: number, userId: number, chatId: number, threadId: number | null): boolean {
    return this.runtime?.approve(id, revision, userId, chatId, threadId) ?? false;
  }
  private keyboard(run: Run): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    if (run.status === "waiting_approval") keyboard.text(run.input.language.startsWith("zh") ? "确认执行" : "Confirm", `agent:${run.id}:${run.revision}:approve`).row();
    if (run.status !== "cancelled") keyboard.text(run.input.language.startsWith("zh") ? "取消" : "Cancel", `agent:${run.id}:${run.revision}:cancel`);
    return keyboard;
  }
  cancelRun(id: string, userId: number, chatId: number, threadId: number | null, key: string): boolean {
    const run = this.options.store.get(id);
    if (!run || run.input.userId !== userId || run.input.chatId !== chatId || run.input.threadId !== threadId || ["completed", "cancelled"].includes(run.status)) return false;
    this.runtime?.enqueue({ ...run.input, key, text: "/cancel", media: [] });
    return true;
  }
  private replyOptions(run: Run): { message_thread_id?: number; reply_parameters: { message_id: number; allow_sending_without_reply: boolean } } {
    return { ...(run.input.threadId === null ? {} : { message_thread_id: run.input.threadId }), reply_parameters: { message_id: run.input.messageId, allow_sending_without_reply: true } };
  }
  private async notify(run: Run): Promise<number | null> {
    if (!this.api || !run.notice) return null;
    const key = `${run.id}:notice:${run.noticeVersion}`;
    const existing = this.options.store.delivery(key);
    if (existing?.status === "delivered") return existing.message_id;
    if (run.noticeMessageId) {
      try {
        await this.api.editMessageText(run.input.chatId, run.noticeMessageId, run.notice, { reply_markup: this.keyboard(run) });
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("message is not modified"))) return run.noticeMessageId;
      }
      this.options.store.setDelivery(key, "delivered", run.noticeMessageId);
      return run.noticeMessageId;
    }
    if (existing) return null;
    this.options.store.setDelivery(key, "sending");
    try {
      const sent = await this.api.sendMessage(run.input.chatId, run.notice, { ...this.replyOptions(run), reply_markup: this.keyboard(run) });
      this.options.store.setDelivery(key, "delivered", sent.message_id);
      return sent.message_id;
    } catch {
      this.options.store.setDelivery(key, "outcome_unknown");
      return null;
    }
  }
  private async sendOnce(key: string, send: () => Promise<Message>): Promise<void> {
    const existing = this.options.store.delivery(key);
    if (existing?.status === "delivered") return;
    if (existing && existing.status !== "failed") throw new AgentModelError("delivery_outcome_unknown", false);
    this.options.store.setDelivery(key, "sending");
    try {
      const sent = await send();
      this.options.store.setDelivery(key, "delivered", sent.message_id);
    } catch (error) {
      const rejected = error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500;
      this.options.store.setDelivery(key, rejected || error instanceof AgentModelError ? "failed" : "outcome_unknown");
      throw new AgentModelError(rejected ? "telegram_delivery_rejected" : error instanceof AgentModelError ? error.code : "delivery_outcome_unknown", false);
    }
  }
  private async deliver(run: Run, current: () => boolean): Promise<void> {
    const api = this.api;
    if (!api || !run.final) return;
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
        } else if (artifact.kind === "video") sent = await api.sendVideo(run.input.chatId, file, this.replyOptions(run));
        else sent = await api.sendDocument(run.input.chatId, file, this.replyOptions(run));
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
    await this.sendOnce(`${run.id}:answer:${run.final.revision}:${run.operations.length}:${run.steps}`, async () => {
      const sent = await api.sendMessage(run.input.chatId, run.final!.text, this.replyOptions(run));
      this.options.contexts.upsertUser({ telegramUserId: this.botId, firstName: "Mia", lastName: null, username: this.botUsername, languageCode: null, isBot: true });
      this.options.contexts.saveMessage({ chatId: run.input.chatId, messageId: sent.message_id, threadId: run.input.threadId, senderUserId: this.botId, senderChatId: null, replyToMessageId: run.input.messageId, contentType: "text", text: run.final!.text, caption: null, entitiesJson: null, mediaFileId: null, mediaUniqueId: null, sentAt: new Date(sent.date * 1000).toISOString(), editedAt: null });
      return sent;
    });
  }
}
