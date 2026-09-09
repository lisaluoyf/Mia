import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrammyError, type Api } from "grammy";
import type { Update } from "grammy/types";
import sharp from "sharp";
import { AgentStore } from "../src/agent/store.js";
import { AgentService } from "../src/agent/service.js";
import { createAgentTools } from "../src/agent/tools.js";
import type { Operation, Run } from "../src/agent/types.js";
import { MediaStore } from "../src/media/store.js";
import { MediaWorker } from "../src/media/worker.js";
import { MediaAPIError, type APIMasterClient } from "../src/clients/apimaster.js";
import type { ModelSettingsService, SettingsSnapshot } from "../src/settings/service.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { createBot } from "../src/telegram/bot.js";
import { miaResponseFromText } from "../src/presentation/schema.js";

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
  const task = run();
  task.status = "queued";
  task.final = { text: "Completed answer", status: "completed", revision: 1 };
  store.save(task);
  const api = { sendRichMessage: vi.fn().mockResolvedValue({ message_id: 100, date: 1_788_333_600, rich_message: { blocks: [] } }), sendMessage: vi.fn().mockResolvedValue({ message_id: 100, date: 1_788_333_600, text: "Completed answer" }), sendDocument: vi.fn().mockResolvedValue({ message_id: 101, document: { file_id: "result-file", file_unique_id: "result-unique" } }) };
  const media = mediaStore();
  const options = { store, media, enabled: false, logger: createLogger("silent"), contexts: { upsertUser: vi.fn(), saveMessage: vi.fn() }, client: {}, settings: {}, credentials: {}, botToken: "test", baseUrl: "https://example.invalid", model: () => "configured", timeoutMs: 1000, webSearch: false } as unknown as ConstructorParameters<typeof AgentService>[0];
  const service = new AgentService(options);
  service.attach(api as unknown as Api, 1000, "MiaBot");
  return { service, store, task, api, media };
}

describe("agent delivery recovery", () => {
  it("renders structured headings and falls back to HTML after definite rich rejection", async () => {
    const f = deliveryFixture();
    f.task.input.text = "Give me a detailed summary";
    f.task.final!.presentation = { ...miaResponseFromText("Body <content>"), title: { text: "Result", emoji: null } };
    f.store.save(f.task);
    f.api.sendRichMessage.mockRejectedValueOnce(new GrammyError("unsupported", { ok: false, error_code: 400, description: "Unsupported rich message" }, "sendRichMessage", {}));
    await f.service.drain();
    const payload = f.api.sendRichMessage.mock.calls[0]?.[1] as { blocks: unknown[] };
    expect(payload.blocks).toContainEqual({ type: "heading", size: 2, text: "Result" });
    expect(f.api.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining("<b>Result</b>"), expect.objectContaining({ parse_mode: "HTML" }));
    expect(f.store.get(f.task.id)?.status).toBe("completed");
    f.task.status = "queued"; f.store.save(f.task);
    await f.service.drain();
    expect(f.api.sendMessage).toHaveBeenCalledTimes(1);
    await f.service.stop();
  });
  it("delivers completed media once with a short caption and no recap", async () => {
    const f = deliveryFixture();
    f.task.input.text = "Make an image";
    const claimed = f.media.claimJob({ telegramUserId: 42, chatId: 42, threadId: null, type: "image_generate", idempotencyKey: "agent:media", requestMessageId: 7, model: "image", instruction: "A landscape", options: { agentRunId: f.task.id } });
    if (claimed.outcome !== "created") throw new Error("Expected media job creation");
    f.media.saveLocalResult(claimed.job.id, new Uint8Array([1, 2, 3]));
    f.media.transitionJob(claimed.job.id, ["queued"], "submitting");
    f.media.transitionJob(claimed.job.id, ["submitting"], "succeeded", { progress: 100, resultMimeType: "image/png" });
    const operation = op("generate_image");
    operation.result = { status: "succeeded", artifact: { jobId: claimed.job.id, kind: "image", revision: 1 } };
    f.task.operations = [operation];
    f.task.final!.presentation = { ...miaResponseFromText("A long generated recap"), title: { text: "Result", emoji: null } };
    f.store.save(f.task);
    await f.service.drain();
    expect(f.api.sendDocument).toHaveBeenCalledOnce();
    expect(f.api.sendDocument.mock.calls[0]?.[2]).toMatchObject({ caption: "Image generated." });
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
