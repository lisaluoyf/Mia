import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrammyError, type Api } from "grammy";
import type { Update } from "grammy/types";
import sharp from "sharp";
import { AgentStore } from "../src/agent/store.js";
import { AgentService } from "../src/agent/service.js";
import { finishTool } from "../src/agent/runtime.js";
import { createAgentTools } from "../src/agent/tools.js";
import type { Operation, Run } from "../src/agent/types.js";
import { MediaStore } from "../src/media/store.js";
import { MediaWorker } from "../src/media/worker.js";
import { MediaAPIError, type APIMasterClient } from "../src/clients/apimaster.js";
import type { ModelSettingsService, SettingsSnapshot } from "../src/settings/service.js";
import { createLogger } from "../src/logger.js";
import { DebugRecorder } from "../src/debug/recorder.js";
import { DebugStore } from "../src/debug/store.js";
import { createServer } from "../src/server.js";
import { createBot } from "../src/telegram/bot.js";

const directories: string[] = [];
const stores: Array<{ close(): void }> = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { const path = mkdtempSync(join(tmpdir(), "mia-agent-test-")); directories.push(path); return path; }
function mediaStore() { const store = new MediaStore(":memory:", { resultDirectory: directory() }); stores.push(store); return store; }
function run(): Run {
  return { id: "run-1", scope: "42:0:42", input: { key: "input-1", userId: 42, chatId: 42, threadId: null, messageId: 7, replyToMessageId: null, language: "en", text: "Make a video", media: [], context: "" }, status: "running", revision: 1, history: [], operations: [], steps: 1, attempts: 0, nextAt: 0, notice: null, noticeVersion: 0, noticeMessageId: null, final: null, updatedAt: Date.now() };
}
function op(name = "generate_video"): Operation {
  return { id: "run-1:0", revision: 1, state: "prepared", approved: true, expiresAt: Date.now() + 600_000, call: { name, call_id: "call-1", arguments: JSON.stringify({ prompt: "A landscape", aspect_ratio: null, resolution: null, duration_seconds: null, source_message_ids: [], source_operation_id: null }) } };
}
function snapshot(): SettingsSnapshot {
  return { apimasterUserId: 1, unavailable: [], settings: { chatModel: "chat", visionModel: "vision", imageModel: "image", videoModel: "video" }, models: [{ id: "video", displayName: "Video", vendor: "test", capability: "video", recommended: true, supportsVision: false, visionRecommended: false, videoCapabilities: { modes: ["text_to_video", "image_to_video"], durationSeconds: { min: 1, max: 15, default: 6 }, resolutions: [], defaultResolution: "", aspectRatios: ["16:9", "9:16"], defaultAspectRatio: "16:9", maxReferenceImages: 2 } }] };
}
function toolsFixture() {
  const media = mediaStore();
  const state = snapshot();
  const client = { resolveAPIKey: vi.fn().mockResolvedValue("own-key") };
  const settings = { getSnapshot: vi.fn().mockResolvedValue(state) };
  const tools = createAgentTools({ media, client: client as unknown as APIMasterClient, settings: settings as unknown as ModelSettingsService, api: {} as Api, botToken: "test" });
  return { tools, media, state, client };
}

function deliveryFixture() {
  const store = new AgentStore(":memory:"); stores.push(store);
  const debugStore = new DebugStore(":memory:"); stores.push(debugStore);
  const debug = new DebugRecorder(debugStore, [42]);
  const task = run();
  task.status = "queued";
  task.final = { text: "Completed answer", status: "completed", revision: 1 };
  store.save(task);
  const api = { raw: { sendRichMessageDraft: vi.fn().mockResolvedValue(true) }, sendChatAction: vi.fn().mockResolvedValue(true), deleteMessage: vi.fn().mockResolvedValue(true), sendRichMessage: vi.fn().mockResolvedValue({ message_id: 100, date: 1_788_333_600, rich_message: { blocks: [] } }), sendMessage: vi.fn().mockResolvedValue({ message_id: 100, date: 1_788_333_600, text: "Completed answer" }), sendDocument: vi.fn().mockResolvedValue({ message_id: 101, document: { file_id: "result-file", file_unique_id: "result-unique" } }) };
  const media = mediaStore();
  const options = { store, media, enabled: false, logger: createLogger("silent"), contexts: { upsertUser: vi.fn(), saveMessage: vi.fn() }, client: {}, settings: {}, credentials: {}, botToken: "test", baseUrl: "https://example.invalid", model: () => "configured", timeoutMs: 1000, webSearch: false, debug } as unknown as ConstructorParameters<typeof AgentService>[0];
  const service = new AgentService(options);
  service.attach(api as unknown as Api, 1000, "MiaBot");
  return { service, store, task, api, media, debugStore };
}

describe("agent delivery recovery", () => {
  it("renders the legacy video draft card for an Agent approval", async () => {
    const f = deliveryFixture();
    const draft = f.media.createDraft({
      telegramUserId: 42, chatId: 42, threadId: null, type: "video_generate", idempotencyKey: "agent:run-1:0",
      requestMessageId: 7, model: "video", instruction: "A warm kitchen scene",
      options: { agentRunId: f.task.id, agentOperationId: "run-1:0", agentRevision: 1, locale: "en", mode: "text_to_video", durationSeconds: 6, aspectRatio: "16:9", resolutionSource: "channel_default" },
    });
    f.task.status = "waiting_approval";
    f.task.final = null;
    f.task.notice = "Confirm before submitting";
    f.task.noticeVersion = 1;
    f.task.operations = [{ ...op(), state: "approval", approved: false, draftJobId: draft.id }];
    f.store.save(f.task);

    await f.service.drain();

    expect(f.api.sendMessage).toHaveBeenCalledOnce();
    const sent = f.api.sendMessage.mock.calls[0] as unknown as [number, string, { reply_markup: { inline_keyboard: Array<Array<{ callback_data?: string }>> } }];
    expect(sent[1]).toContain("Video draft (not charged)");
    expect(sent[2].reply_markup.inline_keyboard.flat().some(button => button.callback_data === `media:${draft.id}:generate`)).toBe(true);
    expect(f.media.getJob(draft.id)?.statusMessageId).toBe(100);
    await f.service.stop();
  });
  it("approves only the draft bound to the current Agent revision", async () => {
    const f = deliveryFixture();
    const draft = f.media.createDraft({
      telegramUserId: 42, chatId: 42, threadId: null, type: "video_generate", idempotencyKey: "agent:run-1:0",
      requestMessageId: 7, model: "video", instruction: "A warm kitchen scene",
      options: { agentRunId: f.task.id, agentOperationId: "run-1:0", agentRevision: 1, locale: "en", mode: "text_to_video", durationSeconds: 6, aspectRatio: "16:9", resolutionSource: "channel_default" },
    });
    f.task.status = "waiting_approval";
    f.task.final = null;
    f.task.operations = [{ ...op(), state: "approval", approved: false, draftJobId: draft.id }];
    f.store.save(f.task);

    expect(f.service.approveVideoDraft(draft, 99)).toBe("changed");
    expect(f.media.getJob(draft.id)?.status).toBe("draft");
    expect(f.service.approveVideoDraft(draft, 42)).toBe("approved");
    expect(f.media.getJob(draft.id)?.status).toBe("queued");
    expect(f.store.get(f.task.id)).toMatchObject({ status: "queued", operations: [{ approved: true, state: "prepared" }] });
    await f.service.stop();
  });
  it("keeps hosted search and media tools available when guest chat plans a task", async () => {
    const store = new AgentStore(":memory:"); stores.push(store);
    const media = mediaStore();
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      status: "completed",
      output: [{ type: "function_call", call_id: "finish-1", name: "finish", arguments: "{}" }],
    }));
    const service = new AgentService({
      store, media, enabled: true, logger: createLogger("silent"), contexts: {}, client: {},
      settings: { getPreferences: vi.fn().mockReturnValue({ chatModel: null }) },
      credentials: { resolve: vi.fn().mockResolvedValue({ apiKey: "guest-key", model: "gpt-5.4", source: "guest", fallbackReason: "no_usable_api_key" }) },
      botToken: "test", baseUrl: "https://example.invalid", model: () => "configured", timeoutMs: 1000,
      webSearch: true,
    } as unknown as ConstructorParameters<typeof AgentService>[0]);
    service.attach({} as Api, 1000, "MiaBot");
    const model = (service as unknown as { runtime: { options: { model: (task: Run, input: Record<string, unknown>[], tools: typeof finishTool[], signal: AbortSignal) => Promise<unknown> } } }).runtime.options.model;
    const mediaTools = createAgentTools({ client: {}, settings: {}, media: {}, api: {}, botToken: "test" } as Parameters<typeof createAgentTools>[0])
      .map(tool => tool.definition);

    await model(run(), [], [...mediaTools, finishTool], new AbortController().signal);

    const body = JSON.parse((fetcher.mock.calls[0]?.[1] as RequestInit).body as string) as { tools: Array<{ type: string; name?: string }> };
    expect(body.tools).toEqual(expect.arrayContaining([{ type: "web_search" }]));
    expect(body.tools.filter(tool => tool.type === "function").map(tool => tool.name)).toEqual([
      "generate_image", "edit_image", "generate_video", "create_sticker", "inspect_image", "read_conversation", "cancel_operation", "finish",
    ]);
    fetcher.mockRestore();
    await service.stop();
  });
  it("shows a temporary rich thinking draft for private model progress", async () => {
    const f = deliveryFixture();
    const progress = (f.service as unknown as { progress: (run: Run, phase: "started" | "receiving", current: () => boolean) => Promise<void> }).progress;
    await progress.call(f.service, f.task, "started", () => true);
    await progress.call(f.service, f.task, "receiving", () => true);
    expect(f.api.raw.sendRichMessageDraft).toHaveBeenCalledOnce();
    expect(f.api.raw.sendRichMessageDraft).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 42,
      rich_message: { blocks: [{ type: "thinking", text: "Thinking\n" }] },
    }));
    expect(f.api.sendChatAction).not.toHaveBeenCalled();
    expect(f.api.sendRichMessage).not.toHaveBeenCalled();
    expect(f.api.sendMessage).not.toHaveBeenCalled();
    await f.service.stop();
  });
  it("falls back to typing in group chats", async () => {
    const f = deliveryFixture();
    f.task.input.chatId = -100;
    const progress = (f.service as unknown as { progress: (run: Run, phase: "started" | "receiving", current: () => boolean) => Promise<void> }).progress;
    await progress.call(f.service, f.task, "started", () => true);
    expect(f.api.raw.sendRichMessageDraft).not.toHaveBeenCalled();
    expect(f.api.sendChatAction).toHaveBeenCalledWith(-100, "typing", {});
    await f.service.stop();
  });
  it("sends private messages directly, retaining a reply only for an explicit user reply", async () => {
    const f = deliveryFixture();
    const replyOptions = (f.service as unknown as { replyOptions: (run: Run) => unknown }).replyOptions;
    expect(replyOptions.call(f.service, f.task)).toEqual({});
    f.task.input.replyToMessageId = 5;
    expect(replyOptions.call(f.service, f.task)).toEqual({ reply_parameters: { message_id: 5, allow_sending_without_reply: true } });
    f.task.input.chatId = -100;
    expect(replyOptions.call(f.service, f.task)).toEqual({ reply_parameters: { message_id: 7, allow_sending_without_reply: true } });
    await f.service.stop();
  });
  it("shows only pre-submission approval, never a cancel action", async () => {
    const f = deliveryFixture();
    const keyboard = (f.service as unknown as { keyboard: (run: Run) => { inline_keyboard: unknown[][] } | null }).keyboard;
    expect(keyboard.call(f.service, f.task)).toBeNull();
    f.task.status = "waiting_tool";
    expect(keyboard.call(f.service, f.task)).toBeNull();
    f.task.status = "waiting_approval";
    expect(keyboard.call(f.service, f.task)?.inline_keyboard).toEqual([[{ text: "Confirm", callback_data: "agent:run-1:1:approve" }]]);
    await f.service.stop();
  });
  it("clears the lightweight generation notice once the media result is delivered", async () => {
    const f = deliveryFixture();
    const claimed = f.media.claimJob({ telegramUserId: 42, chatId: 42, threadId: null, type: "image_edit", idempotencyKey: "agent:run-1:0", requestMessageId: 7, model: "image", instruction: "Make it brighter", options: { agentRunId: f.task.id } });
    if (claimed.outcome !== "created") throw new Error("Expected image job");
    f.media.transitionJob(claimed.job.id, ["queued"], "submitting");
    f.media.transitionJob(claimed.job.id, ["submitting"], "submitted", { upstreamTaskId: "test-task" });
    f.media.transitionJob(claimed.job.id, ["submitted"], "succeeded", { resultMimeType: "image/png" });
    f.media.saveLocalResult(claimed.job.id, Buffer.from("result"));
    f.task.noticeMessageId = 99;
    f.task.operations = [{ ...op("edit_image"), state: "done", result: { status: "succeeded", artifact: { jobId: claimed.job.id, kind: "image", revision: 1 } } }];
    f.store.save(f.task);
    await f.service.drain();
    expect(f.api.deleteMessage).toHaveBeenCalledWith(42, 99);
    await f.service.stop();
  });
  it("renders finish text and falls back to HTML after definite rich rejection", async () => {
    const f = deliveryFixture();
    f.task.final!.text = "Body <content>";
    f.store.save(f.task);
    f.api.sendRichMessage.mockRejectedValueOnce(new GrammyError("unsupported", { ok: false, error_code: 400, description: "Unsupported rich message" }, "sendRichMessage", {}));
    await f.service.drain();
    const payload = f.api.sendRichMessage.mock.calls[0]?.[1] as { blocks: unknown[] };
    expect(payload.blocks).toEqual([{ type: "paragraph", text: "Body <content>" }]);
    expect(f.api.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining("Body &lt;content&gt;"), expect.objectContaining({ parse_mode: "HTML" }));
    expect(f.store.get(f.task.id)?.status).toBe("completed");
    f.task.status = "queued"; f.store.save(f.task);
    await f.service.drain();
    expect(f.api.sendMessage).toHaveBeenCalledTimes(1);
    await f.service.stop();
  });
  it("replaces a Rich progress message with a fresh final response", async () => {
    const f = deliveryFixture();
    f.task.noticeMessageId = 99;
    f.task.notice = "Generating image";
    f.store.save(f.task);

    await f.service.drain();

    expect(f.api.deleteMessage).toHaveBeenCalledWith(42, 99);
    expect(f.api.sendRichMessage).toHaveBeenCalledWith(42, { blocks: [{ type: "paragraph", text: "Completed answer" }] }, expect.anything());
    expect(f.store.get(f.task.id)?.noticeMessageId).toBeNull();
    await f.service.stop();
  });
  it("completes a Rich thinking draft when media execution is blocked", async () => {
    const f = deliveryFixture();
    const progress = (f.service as unknown as { progress: (run: Run, phase: "started" | "receiving", current: () => boolean) => Promise<void> }).progress;
    await progress.call(f.service, f.task, "started", () => true);
    f.task.final = { text: "insufficient_quota", status: "blocked", revision: 1, executionBlock: "insufficient_quota" };
    f.store.save(f.task);

    await f.service.drain();

    expect(f.api.raw.sendRichMessageDraft).toHaveBeenCalledOnce();
    expect(f.api.sendRichMessage).toHaveBeenCalledOnce();
    expect(f.api.sendMessage).not.toHaveBeenCalled();
    await f.service.stop();
  });
  it("records the Agent Loop input, plain final text, and rendered delivery", async () => {
    const f = deliveryFixture();
    f.task.final!.text = "Body";
    f.store.save(f.task);
    await f.service.drain();
    const trace = f.debugStore.list(42)[0];
    expect(trace).toMatchObject({
      kind: "agent_loop",
      status: "succeeded",
      requestPreview: { text: "Make a video" },
      responsePreview: { status: "completed", text: "Body" },
    });
    expect(trace?.details).toMatchObject({ phase: "telegram_delivered", delivery: { mode: "rich_message", chunkCount: 1 } });
    await f.service.stop();
  });
  it("delivers a completed image once with a concise caption and no recap", async () => {
    const f = deliveryFixture();
    const claimed = f.media.claimJob({ telegramUserId: 42, chatId: 42, threadId: null, type: "image_edit", idempotencyKey: "agent:run-1:0", requestMessageId: 7, model: "image", instruction: "Make it brighter", options: { agentRunId: f.task.id } });
    if (claimed.outcome !== "created") throw new Error("Expected image job");
    f.media.transitionJob(claimed.job.id, ["queued"], "submitting");
    f.media.transitionJob(claimed.job.id, ["submitting"], "submitted", { upstreamTaskId: "test-task" });
    f.media.transitionJob(claimed.job.id, ["submitted"], "succeeded", { resultMimeType: "image/png" });
    f.media.saveLocalResult(claimed.job.id, Buffer.from("result"));
    f.task.operations = [{ ...op("edit_image"), state: "done", result: { status: "succeeded", artifact: { jobId: claimed.job.id, kind: "image", revision: 1 } } }];
    f.store.save(f.task);
    await f.service.drain();
    expect(f.api.sendDocument).toHaveBeenCalledWith(42, expect.anything(), expect.objectContaining({ caption: "Image edited." }));
    expect(f.api.sendRichMessage).not.toHaveBeenCalled();
    expect(f.api.sendMessage).not.toHaveBeenCalled();
    await f.service.stop();
  });
  it("falls back to plain text only after both rich and HTML are rejected", async () => {
    const f = deliveryFixture();
    const rejection = new GrammyError("unsupported", { ok: false, error_code: 400, description: "Unsupported formatting" }, "sendMessage", {});
    f.api.sendRichMessage.mockRejectedValueOnce(rejection);
    f.api.sendMessage.mockRejectedValueOnce(rejection);
    await f.service.drain();
    expect(f.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(f.api.sendMessage.mock.calls[1]?.[2]).not.toHaveProperty("parse_mode");
    expect(f.store.get(f.task.id)?.status).toBe("completed");
    await f.service.stop();
  });
  it("does not resend a previously delivered pre-rich answer", async () => {
    const f = deliveryFixture();
    f.store.setDelivery(`${f.task.id}:answer:1:0:1`, "delivered", 123);
    await f.service.drain();
    expect(f.api.sendRichMessage).not.toHaveBeenCalled();
    expect(f.api.sendMessage).not.toHaveBeenCalled();
    await f.service.stop();
  });
  it("does not resend an answer after a checkpoint restart", async () => {
    const f = deliveryFixture();
    await f.service.drain();
    expect(f.store.get(f.task.id)?.status).toBe("completed");
    f.task.status = "queued";
    f.store.save(f.task);
    await f.service.drain();
    expect(f.api.sendRichMessage).toHaveBeenCalledTimes(1);
    await f.service.stop();
  });
  it("preserves indeterminate Telegram sends without blindly retrying", async () => {
    const f = deliveryFixture();
    f.api.sendRichMessage.mockRejectedValue(new Error("connection closed"));
    await f.service.drain();
    expect(f.store.delivery(`${f.task.id}:answer:1:0:1:chunk:0:rich`)?.status).toBe("outcome_unknown");
    expect(f.store.get(f.task.id)?.status).toBe("blocked");
    const count = f.api.sendRichMessage.mock.calls.length;
    await f.service.drain();
    expect(f.api.sendRichMessage).toHaveBeenCalledTimes(count);
    expect(f.api.sendMessage).not.toHaveBeenCalled();
    await f.service.stop();
  });
  it("can retry a definite Telegram rejection without regenerating an artifact", async () => {
    const f = deliveryFixture();
    f.api.sendRichMessage.mockRejectedValueOnce(new GrammyError("send failed", { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } }, "sendRichMessage", {}));
    await f.service.drain();
    expect(f.store.delivery(`${f.task.id}:answer:1:0:1:chunk:0:rich`)?.status).toBe("failed");
    f.task.status = "queued";
    f.store.save(f.task);
    await f.service.drain();
    expect(f.store.get(f.task.id)?.status).toBe("completed");
    expect(f.store.delivery(`${f.task.id}:answer:1:0:1`)?.status).toBe("delivered");
    await f.service.stop();
  });
  it("delivers the final answer after an incidental answer in the same goal revision", async () => {
    const f = deliveryFixture();
    f.task.final!.status = "waiting_input";
    f.store.save(f.task);
    await f.service.drain();
    f.task.status = "queued";
    f.task.steps++;
    f.task.final = { text: "Now the media task is finished", status: "completed", revision: 1 };
    f.store.save(f.task);
    await f.service.drain();
    expect(f.api.sendRichMessage).toHaveBeenCalledTimes(2);
    expect(f.api.sendRichMessage).toHaveBeenLastCalledWith(42, { blocks: [{ type: "paragraph", text: "Now the media task is finished" }] }, expect.anything());
    await f.service.stop();
  });
});

describe("agent capability integration", () => {
  it("does not treat the media request itself as a superseding input", () => {
    const store = new AgentStore(":memory:"); stores.push(store);
    const task = run();
    const operation = op("edit_image");
    operation.approved = false;
    operation.state = "waiting";
    task.operations = [operation];
    task.status = "waiting_tool";
    store.save(task);
    store.enqueue(task.input);
    const service = new AgentService({ store } as unknown as ConstructorParameters<typeof AgentService>[0]);
    const job = { telegramUserId: 42, chatId: 42, threadId: null, requestMessageId: task.input.messageId, type: "image_edit", options: { agentRunId: task.id, agentOperationId: operation.id } } as MediaJob;

    expect(service.canSubmit(job)).toBe(true);

    store.enqueue({ ...task.input, key: "input-2", messageId: task.input.messageId + 1, text: "Use a different edit" });
    expect(service.canSubmit(job)).toBe(false);
  });
  it("requires confirmation only for an Agent video submission", () => {
    const store = new AgentStore(":memory:"); stores.push(store);
    const task = run();
    const operation = { ...op(), state: "waiting", approved: false } as Operation;
    task.operations = [operation];
    task.status = "waiting_tool";
    store.save(task);
    const service = new AgentService({ store } as unknown as ConstructorParameters<typeof AgentService>[0]);
    const job = { telegramUserId: 42, chatId: 42, threadId: null, requestMessageId: task.input.messageId, type: "video_generate", options: { agentRunId: task.id, agentOperationId: operation.id } } as MediaJob;

    expect(service.canSubmit(job)).toBe(false);
    operation.approved = true;
    store.save(task);
    expect(service.canSubmit(job)).toBe(true);
  });
  it("creates a video draft before approval and only queues it after confirmation", async () => {
    const f = toolsFixture();
    const tool = f.tools.find(tool => tool.definition.name === "generate_video")!;
    const operation = op();
    await tool.prepare!(run(), operation);
    const draftId = await tool.createApprovalDraft!(run(), operation);
    operation.draftJobId = draftId;
    const draft = f.media.getJob(draftId)!;
    expect(draft).toMatchObject({ status: "draft", type: "video_generate", options: {
      agentRunId: "run-1", agentOperationId: "run-1:0", agentRevision: 1,
      durationSeconds: 6, aspectRatio: "16:9", resolutionSource: "channel_default",
    } });
    expect(f.media.claimDraft(draftId)).toMatchObject({ outcome: "claimed", job: { status: "queued" } });
    expect(await tool.execute(run(), operation, new AbortController().signal, () => true)).toMatchObject({ status: "pending", jobId: draftId });
  });
  it("preserves channel-default video resolution and stable operation identity", async () => {
    const f = toolsFixture();
    const tool = f.tools.find(tool => tool.definition.name === "generate_video")!;
    const operation = op();
    await tool.prepare!(run(), operation);
    const result = await tool.execute(run(), operation, new AbortController().signal, () => true);
    const repeated = await tool.execute(run(), operation, new AbortController().signal, () => true);
    expect(repeated.jobId).toBe(result.jobId);
    const job = f.media.getJob(result.jobId!)!;
    expect(job.options).toMatchObject({ durationSeconds: 6, aspectRatio: "16:9", resolutionSource: "channel_default", agentRunId: "run-1" });
    expect(job.options).not.toHaveProperty("resolution");
    expect(f.client.resolveAPIKey).toHaveBeenCalledWith(42, "video");
  });
  it("refuses changed models after approval", async () => {
    const f = toolsFixture();
    const tool = f.tools.find(tool => tool.definition.name === "generate_video")!;
    const operation = op();
    await tool.prepare!(run(), operation);
    f.state.settings.videoModel = "different-model";
    const result = await tool.execute(run(), operation, new AbortController().signal, () => true);
    expect(result.error?.code).toBe("approved_configuration_changed");
    expect(f.media.getJobByIdempotencyKey("agent:run-1:0")).toBeNull();
  });
  it("does not submit after input becomes stale during credential resolution", async () => {
    const f = toolsFixture();
    const tool = f.tools.find(tool => tool.definition.name === "generate_image")!;
    expect(await tool.execute(run(), op("generate_image"), new AbortController().signal, () => false)).toMatchObject({ error: { code: "superseded" } });
    expect(f.media.getJobByIdempotencyKey("agent:run-1:0")).toBeNull();
  });
  it("returns parameter and source errors as observations", async () => {
    const f = toolsFixture();
    const tool = f.tools.find(tool => tool.definition.name === "edit_image")!;
    const operation = op("edit_image");
    operation.call.arguments = JSON.stringify({ ...JSON.parse(operation.call.arguments) as Record<string, unknown>, source_message_ids: [999] });
    expect(await tool.execute(run(), operation, new AbortController().signal, () => true)).toMatchObject({ status: "failed", error: { code: "source_not_in_task" } });
    expect(f.media.getJobByIdempotencyKey("agent:run-1:0")).toBeNull();
  });
  it("keeps generated media local until the agent delivery step", async () => {
    const media = mediaStore();
    const claimed = media.claimJob({ telegramUserId: 42, chatId: 42, threadId: null, type: "image_generate", idempotencyKey: "agent:op", requestMessageId: 7, model: "image", instruction: "landscape", options: { agentRunId: "run-1", aspectRatio: "1:1" } });
    if (claimed.outcome !== "created") throw new Error("not created");
    const bytes = await sharp({ create: { width: 16, height: 9, channels: 3, background: "red" } }).png().toBuffer();
    const client = { resolveAPIKey: vi.fn().mockResolvedValue("own-key"), submitImage: vi.fn().mockResolvedValue({ kind: "result", state: { status: "succeeded", progress: 100, errorCode: null, resultBase64: bytes.toString("base64"), resultUrl: null } }) };
    const api = { sendPhoto: vi.fn(), sendDocument: vi.fn(), sendMessage: vi.fn() };
    const worker = new MediaWorker({ client: client as unknown as APIMasterClient, store: media, api: api as unknown as Api, botToken: "test", logger: createLogger("silent"), intervalMs: 1000, resultMaxBytes: 10_000_000, publicBaseUrl: null, botUsername: "MiaBot" });
    await worker.tick();
    expect(media.getJob(claimed.job.id)?.status).toBe("succeeded");
    expect(media.readLocalResult(claimed.job.id, "image/png")?.bytes).toEqual(bytes);
    expect(api.sendDocument).not.toHaveBeenCalled();
    expect(api.sendPhoto).not.toHaveBeenCalled();
    await worker.tick();
    expect(client.submitImage).toHaveBeenCalledTimes(1);
  });
  it("never auto-resubmits an ambiguous agent image request", async () => {
    const media = mediaStore();
    media.claimJob({ telegramUserId: 42, chatId: 42, threadId: null, type: "image_generate", idempotencyKey: "agent:op", requestMessageId: 7, model: "image", instruction: "landscape", options: { agentRunId: "run-1" } });
    const client = { resolveAPIKey: vi.fn().mockResolvedValue("own-key"), submitImage: vi.fn().mockRejectedValue(new MediaAPIError("service_unavailable")) };
    const worker = new MediaWorker({ client: client as unknown as APIMasterClient, store: media, api: {} as Api, botToken: "test", logger: createLogger("silent"), intervalMs: 1000, resultMaxBytes: 10_000_000, publicBaseUrl: null, botUsername: "MiaBot" });
    await worker.tick(); await worker.tick();
    expect(client.submitImage).toHaveBeenCalledTimes(1);
    expect(media.getJobByIdempotencyKey("agent:op")?.errorCode).toBe("submission_outcome_unknown");
  });
  it("checks cancellation again immediately before the remote paid submission", async () => {
    const media = mediaStore();
    media.claimJob({ telegramUserId: 42, chatId: 42, threadId: null, type: "image_generate", idempotencyKey: "agent:cancel", requestMessageId: 7, model: "image", instruction: "landscape", options: { agentRunId: "run-1" } });
    const client = { resolveAPIKey: vi.fn().mockResolvedValue("own-key"), submitImage: vi.fn() };
    const worker = new MediaWorker({ client: client as unknown as APIMasterClient, store: media, api: {} as Api, botToken: "test", logger: createLogger("silent"), intervalMs: 1000, resultMaxBytes: 10_000_000, publicBaseUrl: null, botUsername: "MiaBot", canSubmitAgentJob: () => false });
    await worker.tick();
    expect(client.submitImage).not.toHaveBeenCalled();
    expect(media.getJobByIdempotencyKey("agent:cancel")?.errorCode).toBe("cancelled_before_submission");
  });
});

describe("durable agent ingress", () => {
  it("retains input and run checkpoints across reopening SQLite", () => {
    const path = join(directory(), "agent.sqlite");
    const first = new AgentStore(path);
    const task = run();
    first.enqueue(task.input);
    first.enqueueUpdate({ update_id: 7 });
    first.consume(task.input, [task]);
    first.close();
    const second = new AgentStore(path); stores.push(second);
    expect(second.get(task.id)).toEqual(expect.objectContaining({ id: task.id, revision: 1 }));
    expect(second.inputs()).toEqual([]);
    expect(second.updates()).toEqual([{ update_id: 7 }]);
    expect(second.enqueue(task.input)).toBe(false);
  });
  it("does not acknowledge webhook input if durable enqueue fails", async () => {
    const handleUpdate = vi.fn();
    const app = createServer({ logger: createLogger("silent"), serviceKey: "internal-key", handleUpdate, enqueueUpdate: () => { throw new Error("disk unavailable"); } });
    const response = await app.inject({ method: "POST", url: "/telegram/update", headers: { "x-mia-internal-key": "internal-key" }, payload: { update_id: 1 } });
    expect(response.statusCode).toBe(500);
    expect(handleUpdate).not.toHaveBeenCalled();
    await app.close();
  });
  it("acknowledges only after durable enqueue without double-dispatch", async () => {
    const handleUpdate = vi.fn();
    const enqueueUpdate = vi.fn().mockReturnValue(true);
    const app = createServer({ logger: createLogger("silent"), serviceKey: "internal-key", handleUpdate, enqueueUpdate });
    const response = await app.inject({ method: "POST", url: "/telegram/update", headers: { "x-mia-internal-key": "internal-key" }, payload: { update_id: 1 } });
    expect(response.statusCode).toBe(202);
    expect(enqueueUpdate).toHaveBeenCalledWith({ update_id: 1 });
    expect(handleUpdate).not.toHaveBeenCalled();
    await app.close();
  });
  it("routes enabled Telegram input into the agent without legacy classification", async () => {
    const media = mediaStore();
    const enqueue = vi.fn();
    const agent = { enabled: () => true, ownsUpdate: () => true, enqueue } as unknown as AgentService;
    const classify = vi.fn();
    const bot = createBot("123:test", { agent, client: {} as APIMasterClient, logger: createLogger("silent"), settings: { getPreferences: vi.fn() }, contexts: { upsertUser: vi.fn(), upsertChat: vi.fn(), upsertMember: vi.fn(), saveMessage: vi.fn() }, mediaStore: media, router: { classify } as never });
    bot.botInfo = { id: 100, is_bot: true, first_name: "Mia", username: "MiaBot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
    const update = { update_id: 1, message: { message_id: 7, date: 1_788_333_600, chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "Test" }, text: "Make an image and then explain it" } } satisfies Update;
    await bot.handleUpdate(update);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: 42, text: "Make an image and then explain it", key: "42:7" }));
    expect(classify).not.toHaveBeenCalled();
  });
  it("keeps the global rollout switch disabled by default and enables every user when turned on", () => {
    const options = { enabled: false } as ConstructorParameters<typeof AgentService>[0];
    expect(new AgentService(options).enabled(42)).toBe(false);
    expect(new AgentService({ ...options, enabled: true }).enabled(42)).toBe(true);
    expect(new AgentService({ ...options, enabled: true }).enabled(99)).toBe(true);
  });
});
