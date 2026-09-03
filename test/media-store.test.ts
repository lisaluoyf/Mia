import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { MediaStore } from "../src/media/store.js";
import type { MediaInput, NewMediaJobInput } from "../src/media/types.js";

const MINUTE = 60 * 1_000;
const DAY = 24 * 60 * MINUTE;

function job(overrides: Partial<NewMediaJobInput> = {}): NewMediaJobInput {
  return {
    telegramUserId: 42,
    chatId: 42,
    threadId: null,
    type: "image_generate",
    idempotencyKey: "update:1",
    requestMessageId: 10,
    statusMessageId: null,
    model: "gpt-image-2",
    instruction: "A cat in Shanghai",
    options: { aspectRatio: "1:1", resolution: "1K" },
    ...overrides,
  };
}

function media(position: number, overrides: Partial<MediaInput> = {}): MediaInput {
  return {
    position,
    messageId: 20 + position,
    fileId: `file-${position}`,
    fileUniqueId: `unique-${position}`,
    type: "photo",
    mimeType: "image/jpeg",
    mediaGroupId: "album-1",
    ...overrides,
  };
}

describe("media store", () => {
  let store: MediaStore | undefined;
  let temporaryDirectory: string | undefined;
  let now = new Date("2026-09-02T08:00:00.000Z");

  afterEach(() => {
    store?.close();
    store = undefined;
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
    now = new Date("2026-09-02T08:00:00.000Z");
  });

  function createStore(databasePath = ":memory:"): MediaStore {
    store = new MediaStore(databasePath, { now: () => now });
    return store;
  }

  it("isolates pending intents by user, chat, and topic and expires them after ten minutes", () => {
    const current = createStore();
    const base = {
      telegramUserId: 42,
      chatId: -1001,
      intent: "image_edit" as const,
      slots: { instruction: "brighter" },
      missingRequired: ["media_source"],
      sourceMessageIds: [7],
    };

    current.savePendingIntent({ ...base, threadId: 10 });
    current.savePendingIntent({ ...base, threadId: 20, intent: "vision_qa" });
    current.savePendingIntent({ ...base, telegramUserId: 99, threadId: 10 });

    expect(current.getPendingIntent({ telegramUserId: 42, chatId: -1001, threadId: 10 })).toMatchObject({
      intent: "image_edit",
      missingRequired: ["media_source"],
      slots: { instruction: "brighter" },
    });
    expect(current.getPendingIntent({ telegramUserId: 42, chatId: -1001, threadId: 20 })?.intent)
      .toBe("vision_qa");
    expect(current.getPendingIntent({ telegramUserId: 42, chatId: -1001, threadId: null })).toBeNull();

    current.savePendingIntent({
      ...base,
      threadId: 10,
      slots: { instruction: "snowy background" },
      missingRequired: [],
      sourceMessageIds: [7, 8],
    });
    expect(current.getPendingIntent({ telegramUserId: 42, chatId: -1001, threadId: 10 })).toMatchObject({
      slots: { instruction: "snowy background" },
      sourceMessageIds: [7, 8],
    });

    now = new Date(now.getTime() + 10 * MINUTE);
    expect(current.getPendingIntent({ telegramUserId: 42, chatId: -1001, threadId: 10 })).toBeNull();
    expect(current.getPendingIntent({ telegramUserId: 99, chatId: -1001, threadId: 10 })).toBeNull();
  });

  it("stores sticker creation as a pending media intent", () => {
    const current = createStore();
    current.savePendingIntent({
      telegramUserId: 42,
      chatId: 42,
      threadId: null,
      intent: "sticker_create",
      slots: { intent: "sticker_create", instruction: "做一个无语反应" },
      missingRequired: ["image"],
      sourceMessageIds: [7],
    });

    expect(current.getPendingIntent({ telegramUserId: 42, chatId: 42, threadId: null })).toMatchObject({
      intent: "sticker_create",
      missingRequired: ["image"],
    });
  });

  it("migrates the old pending-intent constraint without losing rows", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "mia-pending-sticker-"));
    const databasePath = join(temporaryDirectory, "mia.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE mia_pending_intents (
        telegram_user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL DEFAULT 0 CHECK (thread_id >= 0),
        intent TEXT NOT NULL CHECK (intent IN ('image_generate', 'image_edit', 'vision_qa', 'video_generate')),
        slots_json TEXT NOT NULL,
        missing_required_json TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (telegram_user_id, chat_id, thread_id)
      );
      INSERT INTO mia_pending_intents VALUES (
        42, 42, 0, 'image_edit', '{"instruction":"brighter"}', '["image"]', '[7]',
        '2026-09-02T08:00:00.000Z', '2026-09-02T08:00:00.000Z', '2026-09-02T08:10:00.000Z'
      );
    `);
    legacy.close();

    const current = createStore(databasePath);
    expect(current.getPendingIntent({ telegramUserId: 42, chatId: 42, threadId: null })?.intent).toBe("image_edit");
    current.savePendingIntent({
      telegramUserId: 99, chatId: 99, threadId: null, intent: "sticker_create",
      slots: {}, missingRequired: ["image"], sourceMessageIds: [8],
    });
    expect(current.getPendingIntent({ telegramUserId: 99, chatId: 99, threadId: null })?.intent).toBe("sticker_create");
  });

  it("claims Telegram update IDs once across restarts", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "mia-update-id-"));
    const databasePath = join(temporaryDirectory, "mia.sqlite");
    const current = createStore(databasePath);
    expect(current.claimTelegramUpdate(123)).toBe(true);
    expect(current.claimTelegramUpdate(123)).toBe(false);
    current.close();
    store = undefined;
    expect(createStore(databasePath).claimTelegramUpdate(123)).toBe(false);
  });

  it("atomically claims at most three active jobs per user and makes idempotency global", () => {
    const current = createStore();
    const first = current.claimJob(job(), [media(1), media(0)]);
    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") throw new Error("Expected job creation");
    expect(current.listJobInputs(first.job.id).map((input) => input.position)).toEqual([0, 1]);

    const duplicate = current.claimJob(job({ chatId: -1001, threadId: 10 }));
    expect(duplicate).toMatchObject({ outcome: "existing", job: { id: first.job.id } });
    expect(current.claimJob(job({ idempotencyKey: "update:2", chatId: -1001 }))).toMatchObject({
      outcome: "created",
    });
    expect(current.claimJob(job({ idempotencyKey: "update:3", chatId: -2002 }))).toMatchObject({
      outcome: "created",
    });
    expect(current.countActiveJobs(42)).toBe(3);
    expect(current.claimJob(job({ idempotencyKey: "update:4" }))).toEqual({
      outcome: "limit_reached",
      activeCount: 3,
    });

    expect(current.claimJob(job({ telegramUserId: 99, idempotencyKey: "user-99:update:1" }))).toMatchObject({
      outcome: "created",
    });
  });

  it("does not count drafts until confirmation and claims a draft only once", () => {
    const current = createStore();
    const draft = current.createDraft(job({
      type: "video_generate",
      idempotencyKey: "video-draft:1",
      model: "minimax-h3",
      options: { durationSeconds: 4, aspectRatio: "16:9", resolution: "768P" },
    }), [media(0)]);
    expect(draft.status).toBe("draft");
    expect(current.countActiveJobs(42)).toBe(0);

    expect(current.claimDraft(draft.id)).toMatchObject({ outcome: "claimed", job: { status: "queued" } });
    expect(current.countActiveJobs(42)).toBe(1);
    expect(current.claimDraft(draft.id)).toMatchObject({
      outcome: "already_claimed",
      job: { status: "queued" },
    });

    const expiring = current.createDraft(job({ idempotencyKey: "video-draft:2", type: "video_generate" }));
    now = new Date(now.getTime() + 10 * MINUTE);
    expect(current.claimDraft(expiring.id)).toMatchObject({ outcome: "expired", job: { status: "expired" } });
  });

  it("enforces transitions and lists resumable jobs across a process restart", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "mia-media-store-"));
    const databasePath = join(temporaryDirectory, "mia.sqlite");
    const current = createStore(databasePath);
    const claimed = current.claimJob(job());
    if (claimed.outcome !== "created") throw new Error("Expected job creation");

    expect(current.transitionJob(claimed.job.id, ["queued"], "submitting")?.status).toBe("submitting");
    expect(current.transitionJob(claimed.job.id, ["submitting"], "submitted", {
      upstreamTaskId: "task-123",
      statusMessageId: 50,
    })).toMatchObject({ status: "submitted", upstreamTaskId: "task-123", statusMessageId: 50 });
    expect(current.transitionJob(claimed.job.id, ["submitted"], "in_progress", { progress: 35 })?.progress)
      .toBe(35);
    expect(() => current.transitionJob(claimed.job.id, ["in_progress"], "queued")).toThrow(
      "Invalid media job transition",
    );
    expect(current.transitionJob(claimed.job.id, ["queued"], "submitting")).toBeNull();

    current.close();
    store = new MediaStore(databasePath, { now: () => now });
    expect(store.listResumableJobs()).toMatchObject([
      { id: claimed.job.id, status: "in_progress", upstreamTaskId: "task-123", progress: 35 },
    ]);
    expect(store.getJobByIdempotencyKey("update:1")?.id).toBe(claimed.job.id);
    expect(store.transitionJob(claimed.job.id, ["in_progress"], "succeeded", {
      progress: 100,
      resultUrl: "https://media.example/result.png",
      resultMimeType: "image/png",
      resultTelegramFileId: "telegram-result",
    })).toMatchObject({ status: "succeeded", progress: 100 });
    expect(store.listResumableJobs()).toEqual([]);
  });

  it("stores a private current image for thirty minutes and defaults group media to enabled", () => {
    const current = createStore();
    current.setActivePrivateImage({
      telegramUserId: 42,
      chatId: 42,
      messageId: 10,
      fileId: "photo-file",
      fileUniqueId: "photo-unique",
      type: "photo",
      mimeType: "image/jpeg",
      mediaGroupId: null,
    });
    expect(current.getActivePrivateImage(42, 42)?.fileId).toBe("photo-file");
    expect(current.isGroupMediaEnabled(-1001)).toBe(true);
    current.setGroupMediaEnabled(-1001, false);
    expect(current.isGroupMediaEnabled(-1001)).toBe(false);
    current.setGroupMediaEnabled(-1001, true);
    expect(current.isGroupMediaEnabled(-1001)).toBe(true);

    now = new Date(now.getTime() + 30 * MINUTE);
    expect(current.getActivePrivateImage(42, 42)).toBeNull();
  });

  it("creates kind-scoped unguessable access tokens and expires them after seven days", () => {
    const current = createStore();
    const claimed = current.claimJob(job());
    if (claimed.outcome !== "created") throw new Error("Expected job creation");
    const share = current.createAccessToken("share", claimed.job.id);
    const download = current.createAccessToken("download", claimed.job.id);

    expect(share.token).toHaveLength(43);
    expect(download.token).not.toBe(share.token);
    expect(current.getAccessToken(share.token, "share"))?.toMatchObject({ kind: "share", jobId: claimed.job.id });
    expect(current.getAccessToken(share.token, "download")).toBeNull();
    expect(current.revokeAccessToken(download.token)).toBe(true);
    expect(current.getAccessToken(download.token)).toBeNull();

    now = new Date(now.getTime() + 7 * DAY);
    expect(current.getAccessToken(share.token)).toBeNull();
  });

  it("stores Base64 results privately and removes them after retention expires", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "mia-media-results-"));
    const current = new MediaStore(":memory:", {
      now: () => now,
      resultDirectory: join(temporaryDirectory, "results"),
    });
    store = current;
    const claimed = current.claimJob(job());
    if (claimed.outcome !== "created") throw new Error("Expected job creation");
    current.saveLocalResult(claimed.job.id, Buffer.from("original-image"));
    current.transitionJob(claimed.job.id, ["queued"], "submitting");
    current.transitionJob(claimed.job.id, ["submitting"], "submitted", { upstreamTaskId: "task-1" });
    current.transitionJob(claimed.job.id, ["submitted"], "succeeded", { resultMimeType: "image/png" });

    const stored = current.readLocalResult(claimed.job.id, "image/png");
    expect(Buffer.from(stored?.bytes ?? []).toString("utf8")).toBe("original-image");
    expect(stored?.filename).toBe("mia-image.png");

    now = new Date(now.getTime() + 7 * DAY);
    current.cleanupExpired();
    expect(current.getLocalResult(claimed.job.id, "image/png")).toBeNull();
  });

  it("expires timed-out jobs and later clears retained media references without deleting audit rows", () => {
    const current = createStore();
    const claimed = current.claimJob(job(), [media(0)]);
    if (claimed.outcome !== "created") throw new Error("Expected job creation");
    current.createAccessToken("share", claimed.job.id);

    now = new Date(now.getTime() + 15 * MINUTE);
    const firstCleanup = current.cleanupExpired();
    expect(firstCleanup).toMatchObject({ jobsExpired: 1, jobsMediaCleared: 0 });
    expect(current.getJob(claimed.job.id)?.status).toBe("expired");

    now = new Date(now.getTime() + 7 * DAY);
    const secondCleanup = current.cleanupExpired();
    expect(secondCleanup).toMatchObject({ jobsExpired: 0, jobsMediaCleared: 1, inputRowsDeleted: 1 });
    expect(current.getJob(claimed.job.id)).toMatchObject({
      status: "expired",
      resultUrl: null,
      resultTelegramFileId: null,
    });
    expect(current.listJobInputs(claimed.job.id)).toEqual([]);
  });

  it("creates its tables without reading or changing SQLite user_version", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "mia-media-version-"));
    const databasePath = join(temporaryDirectory, "mia.sqlite");
    const database = new Database(databasePath);
    database.pragma("user_version = 37");
    database.close();

    createStore(databasePath).close();
    store = undefined;
    const verification = new Database(databasePath, { readonly: true });
    expect(verification.pragma("user_version", { simple: true })).toBe(37);
    expect(verification.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'mia_media_jobs'
    `).get()).toEqual({ count: 1 });
    verification.close();
  });
});
