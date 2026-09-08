import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import type {
  ActivePrivateImage,
  ActivePrivateImageInput,
  ClaimMediaDraftResult,
  ClaimMediaJobResult,
  ConversationCoordinates,
  MediaAccessToken,
  MediaAccessTokenKind,
  MediaCleanupResult,
  MediaInput,
  MediaJob,
  MediaJobStatus,
  MediaJobTransitionPatch,
  MediaStoreOptions,
  NewMediaJobInput,
  PendingIntent,
  PendingIntentInput,
  StoredMediaInput,
  TelegramMediaReference,
} from "./types.js";

const NO_THREAD = 0;
const DEFAULT_PENDING_INTENT_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_ACTIVE_IMAGE_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_DRAFT_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_IMAGE_JOB_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_VIDEO_JOB_TIMEOUT_MS = 60 * 60 * 1_000;
const DEFAULT_RETENTION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_ACTIVE_JOB_LIMIT = 3;

const ACTIVE_STATUSES = ["queued", "submitting", "submitted", "in_progress"] as const;
const RESUMABLE_STATUSES = ["queued", "submitting", "submitted", "in_progress"] as const;
const TERMINAL_STATUSES = ["succeeded", "failed", "expired"] as const;

const ALLOWED_TRANSITIONS: Readonly<Record<MediaJobStatus, readonly MediaJobStatus[]>> = {
  draft: ["queued", "expired"],
  queued: ["submitting", "failed", "expired"],
  submitting: ["submitted", "succeeded", "failed", "expired"],
  submitted: ["in_progress", "succeeded", "failed", "expired"],
  in_progress: ["succeeded", "failed", "expired"],
  succeeded: [],
  failed: [],
  expired: [],
};

interface PendingIntentRow {
  telegram_user_id: number;
  chat_id: number;
  thread_id: number;
  intent: PendingIntent["intent"];
  slots_json: string;
  missing_required_json: string;
  source_message_ids_json: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

interface MediaJobRow {
  id: number;
  job_type: MediaJob["type"];
  status: MediaJobStatus;
  idempotency_key: string;
  telegram_user_id: number;
  chat_id: number;
  thread_id: number;
  request_message_id: number;
  status_message_id: number | null;
  model: string;
  instruction: string;
  options_json: string;
  upstream_task_id: string | null;
  progress: number | null;
  result_url: string | null;
  result_mime_type: string | null;
  result_telegram_file_id: string | null;
  result_telegram_unique_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  completed_at: string | null;
  deadline_at: string;
  retention_expires_at: string;
}

interface MediaInputRow {
  id: number;
  job_id: number;
  position: number;
  message_id: number;
  file_id: string;
  file_unique_id: string | null;
  input_type: MediaInput["type"];
  mime_type: string | null;
  media_group_id: string | null;
  created_at: string;
}

interface ActiveImageRow {
  telegram_user_id: number;
  chat_id: number;
  message_id: number;
  file_id: string;
  file_unique_id: string | null;
  input_type: ActivePrivateImage["type"];
  mime_type: string | null;
  media_group_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

interface AccessTokenRow {
  token: string;
  token_kind: MediaAccessTokenKind;
  job_id: number;
  created_at: string;
  expires_at: string;
}

interface CountRow {
  count: number;
}

interface ChangesResult {
  changes: number;
}

export interface LocalMediaResult {
  path: string;
  size: number;
  mimeType: string;
  filename: string;
}

function requireSafeInteger(value: number, name: string, allowNegative = false): void {
  if (!Number.isSafeInteger(value) || value === 0 || (!allowNegative && value < 0)) {
    throw new TypeError(`${name} must be a ${allowNegative ? "non-zero " : "positive "}safe integer`);
  }
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be empty`);
}

function requirePositiveDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
}

function parseObject(json: string, name: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid stored ${name}`);
  }
  return value as Record<string, unknown>;
}

function parseStringArray(json: string, name: string): string[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Invalid stored ${name}`);
  }
  return value;
}

function parseNumberArray(json: string, name: string): number[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || !value.every((item) => Number.isSafeInteger(item) && item > 0)) {
    throw new Error(`Invalid stored ${name}`);
  }
  return value as number[];
}

function normalizeThreadId(threadId: number | null): number {
  if (threadId !== null) requireSafeInteger(threadId, "threadId");
  return threadId ?? NO_THREAD;
}

function validateCoordinates(input: ConversationCoordinates): number {
  requireSafeInteger(input.telegramUserId, "telegramUserId");
  requireSafeInteger(input.chatId, "chatId", true);
  return normalizeThreadId(input.threadId);
}

function pendingIntentFromRow(row: PendingIntentRow): PendingIntent {
  return {
    telegramUserId: row.telegram_user_id,
    chatId: row.chat_id,
    threadId: row.thread_id === NO_THREAD ? null : row.thread_id,
    intent: row.intent,
    slots: parseObject(row.slots_json, "pending intent slots"),
    missingRequired: parseStringArray(row.missing_required_json, "missing required fields"),
    sourceMessageIds: parseNumberArray(row.source_message_ids_json, "source message IDs"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function mediaJobFromRow(row: MediaJobRow): MediaJob {
  return {
    id: row.id,
    type: row.job_type,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    telegramUserId: row.telegram_user_id,
    chatId: row.chat_id,
    threadId: row.thread_id === NO_THREAD ? null : row.thread_id,
    requestMessageId: row.request_message_id,
    statusMessageId: row.status_message_id,
    model: row.model,
    instruction: row.instruction,
    options: parseObject(row.options_json, "media job options"),
    upstreamTaskId: row.upstream_task_id,
    progress: row.progress,
    resultUrl: row.result_url,
    resultMimeType: row.result_mime_type,
    resultTelegramFileId: row.result_telegram_file_id,
    resultTelegramUniqueId: row.result_telegram_unique_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    deadlineAt: row.deadline_at,
    retentionExpiresAt: row.retention_expires_at,
  };
}

function mediaInputFromRow(row: MediaInputRow): StoredMediaInput {
  return {
    id: row.id,
    jobId: row.job_id,
    position: row.position,
    messageId: row.message_id,
    fileId: row.file_id,
    fileUniqueId: row.file_unique_id,
    type: row.input_type,
    mimeType: row.mime_type,
    mediaGroupId: row.media_group_id,
    createdAt: row.created_at,
  };
}

function activeImageFromRow(row: ActiveImageRow): ActivePrivateImage {
  return {
    telegramUserId: row.telegram_user_id,
    chatId: row.chat_id,
    messageId: row.message_id,
    fileId: row.file_id,
    fileUniqueId: row.file_unique_id,
    type: row.input_type,
    mimeType: row.mime_type,
    mediaGroupId: row.media_group_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function accessTokenFromRow(row: AccessTokenRow): MediaAccessToken {
  return {
    token: row.token,
    kind: row.token_kind,
    jobId: row.job_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export class MediaStore {
  private readonly database: Database.Database;
  private readonly resultDirectory: string | null;
  private readonly now: () => Date;
  private readonly pendingIntentTtlMs: number;
  private readonly activeImageTtlMs: number;
  private readonly draftTtlMs: number;
  private readonly imageJobTimeoutMs: number;
  private readonly videoJobTimeoutMs: number;
  private readonly retentionTtlMs: number;

  constructor(databasePath: string, options: MediaStoreOptions = {}) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.resultDirectory = options.resultDirectory ??
      (databasePath === ":memory:" ? null : join(dirname(databasePath), "media-results"));
    if (this.resultDirectory) mkdirSync(this.resultDirectory, { recursive: true, mode: 0o700 });
    this.now = options.now ?? (() => new Date());
    this.pendingIntentTtlMs = options.pendingIntentTtlMs ?? DEFAULT_PENDING_INTENT_TTL_MS;
    this.activeImageTtlMs = options.activeImageTtlMs ?? DEFAULT_ACTIVE_IMAGE_TTL_MS;
    this.draftTtlMs = options.draftTtlMs ?? DEFAULT_DRAFT_TTL_MS;
    this.imageJobTimeoutMs = options.imageJobTimeoutMs ?? DEFAULT_IMAGE_JOB_TIMEOUT_MS;
    this.videoJobTimeoutMs = options.videoJobTimeoutMs ?? DEFAULT_VIDEO_JOB_TIMEOUT_MS;
    this.retentionTtlMs = options.retentionTtlMs ?? DEFAULT_RETENTION_TTL_MS;
    for (const [name, duration] of Object.entries({
      pendingIntentTtlMs: this.pendingIntentTtlMs,
      activeImageTtlMs: this.activeImageTtlMs,
      draftTtlMs: this.draftTtlMs,
      imageJobTimeoutMs: this.imageJobTimeoutMs,
      videoJobTimeoutMs: this.videoJobTimeoutMs,
      retentionTtlMs: this.retentionTtlMs,
    })) requirePositiveDuration(duration, name);

    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS mia_pending_intents (
        telegram_user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL DEFAULT 0 CHECK (thread_id >= 0),
        intent TEXT NOT NULL CHECK (intent IN ('image_generate', 'image_edit', 'sticker_create', 'vision_qa', 'video_generate')),
        slots_json TEXT NOT NULL,
        missing_required_json TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (telegram_user_id, chat_id, thread_id)
      );

      CREATE INDEX IF NOT EXISTS idx_mia_pending_intents_expiry
        ON mia_pending_intents(expires_at);

      CREATE TABLE IF NOT EXISTS mia_media_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type TEXT NOT NULL CHECK (job_type IN ('image_generate', 'image_edit', 'video_generate')),
        status TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'submitting', 'submitted', 'in_progress', 'succeeded', 'failed', 'expired')),
        idempotency_key TEXT NOT NULL UNIQUE,
        telegram_user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL DEFAULT 0 CHECK (thread_id >= 0),
        request_message_id INTEGER NOT NULL CHECK (request_message_id > 0),
        status_message_id INTEGER CHECK (status_message_id > 0),
        model TEXT NOT NULL,
        instruction TEXT NOT NULL,
        options_json TEXT NOT NULL,
        upstream_task_id TEXT,
        progress REAL CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100)),
        result_url TEXT,
        result_mime_type TEXT,
        result_telegram_file_id TEXT,
        result_telegram_unique_id TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        submitted_at TEXT,
        completed_at TEXT,
        deadline_at TEXT NOT NULL,
        retention_expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mia_media_jobs_user_active
        ON mia_media_jobs(telegram_user_id, status);
      CREATE INDEX IF NOT EXISTS idx_mia_media_jobs_resume
        ON mia_media_jobs(status, deadline_at, id);
      CREATE INDEX IF NOT EXISTS idx_mia_media_jobs_retention
        ON mia_media_jobs(retention_expires_at);

      CREATE TABLE IF NOT EXISTS mia_media_job_inputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES mia_media_jobs(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        message_id INTEGER NOT NULL CHECK (message_id > 0),
        file_id TEXT NOT NULL,
        file_unique_id TEXT,
        input_type TEXT NOT NULL CHECK (input_type IN ('photo', 'document')),
        mime_type TEXT,
        media_group_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (job_id, position)
      );

      CREATE INDEX IF NOT EXISTS idx_mia_media_inputs_group
        ON mia_media_job_inputs(media_group_id, message_id);

      CREATE TABLE IF NOT EXISTS mia_telegram_media_refs (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL CHECK (message_id > 0),
        thread_id INTEGER NOT NULL DEFAULT 0 CHECK (thread_id >= 0),
        position INTEGER NOT NULL DEFAULT 0,
        file_id TEXT NOT NULL,
        file_unique_id TEXT,
        input_type TEXT NOT NULL CHECK (input_type IN ('photo', 'document')),
        mime_type TEXT,
        media_group_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_mia_telegram_media_group
        ON mia_telegram_media_refs(chat_id, thread_id, media_group_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_mia_telegram_media_expiry
        ON mia_telegram_media_refs(expires_at);

      CREATE TABLE IF NOT EXISTS mia_private_active_images (
        telegram_user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL CHECK (message_id > 0),
        file_id TEXT NOT NULL,
        file_unique_id TEXT,
        input_type TEXT NOT NULL CHECK (input_type IN ('photo', 'document')),
        mime_type TEXT,
        media_group_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (telegram_user_id, chat_id)
      );

      CREATE INDEX IF NOT EXISTS idx_mia_private_active_images_expiry
        ON mia_private_active_images(expires_at);

      CREATE TABLE IF NOT EXISTS mia_media_access_tokens (
        token TEXT PRIMARY KEY,
        token_kind TEXT NOT NULL CHECK (token_kind IN ('share', 'download')),
        job_id INTEGER NOT NULL REFERENCES mia_media_jobs(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mia_media_access_tokens_expiry
        ON mia_media_access_tokens(expires_at);

      CREATE TABLE IF NOT EXISTS mia_group_media_settings (
        chat_id INTEGER PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mia_processed_updates (
        update_id INTEGER PRIMARY KEY CHECK (update_id >= 0),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mia_processed_updates_expiry
        ON mia_processed_updates(expires_at);
    `);
    this.migratePendingStickerIntent();
  }

  private migratePendingStickerIntent(): void {
    const row = this.database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mia_pending_intents'",
    ).get() as { sql: string } | undefined;
    if (!row || row.sql.includes("'sticker_create'")) return;
    this.database.exec(`
      BEGIN IMMEDIATE;
      DROP INDEX IF EXISTS idx_mia_pending_intents_expiry;
      ALTER TABLE mia_pending_intents RENAME TO mia_pending_intents_legacy;
      CREATE TABLE mia_pending_intents (
        telegram_user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL DEFAULT 0 CHECK (thread_id >= 0),
        intent TEXT NOT NULL CHECK (intent IN ('image_generate', 'image_edit', 'sticker_create', 'vision_qa', 'video_generate')),
        slots_json TEXT NOT NULL,
        missing_required_json TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (telegram_user_id, chat_id, thread_id)
      );
      INSERT INTO mia_pending_intents (
        telegram_user_id, chat_id, thread_id, intent, slots_json,
        missing_required_json, source_message_ids_json, created_at, updated_at, expires_at
      )
      SELECT
        telegram_user_id, chat_id, thread_id, intent, slots_json,
        missing_required_json, source_message_ids_json, created_at, updated_at, expires_at
      FROM mia_pending_intents_legacy;
      DROP TABLE mia_pending_intents_legacy;
      CREATE INDEX idx_mia_pending_intents_expiry ON mia_pending_intents(expires_at);
      COMMIT;
    `);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private after(milliseconds: number): string {
    return new Date(this.now().getTime() + milliseconds).toISOString();
  }

  private jobTimeout(type: MediaJob["type"]): number {
    return type === "video_generate" ? this.videoJobTimeoutMs : this.imageJobTimeoutMs;
  }

  private validateNewJob(input: NewMediaJobInput): number {
    const threadId = validateCoordinates(input);
    requireSafeInteger(input.requestMessageId, "requestMessageId");
    if (input.statusMessageId !== undefined && input.statusMessageId !== null) {
      requireSafeInteger(input.statusMessageId, "statusMessageId");
    }
    requireNonEmpty(input.idempotencyKey, "idempotencyKey");
    requireNonEmpty(input.model, "model");
    requireNonEmpty(input.instruction, "instruction");
    JSON.stringify(input.options);
    return threadId;
  }

  private insertJob(input: NewMediaJobInput, status: "draft" | "queued", inputs: readonly MediaInput[]): MediaJob {
    const threadId = this.validateNewJob(input);
    this.validateInputs(inputs);
    const now = this.timestamp();
    const deadlineAt = new Date(
      this.now().getTime() + (status === "draft" ? this.draftTtlMs : this.jobTimeout(input.type)),
    ).toISOString();
    const retentionExpiresAt = new Date(this.now().getTime() + this.retentionTtlMs).toISOString();
    const result = this.database.prepare(`
      INSERT INTO mia_media_jobs (
        job_type, status, idempotency_key, telegram_user_id, chat_id, thread_id,
        request_message_id, status_message_id, model, instruction, options_json,
        created_at, updated_at, deadline_at, retention_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.type,
      status,
      input.idempotencyKey,
      input.telegramUserId,
      input.chatId,
      threadId,
      input.requestMessageId,
      input.statusMessageId ?? null,
      input.model,
      input.instruction,
      JSON.stringify(input.options),
      now,
      now,
      deadlineAt,
      retentionExpiresAt,
    );
    const jobId = Number(result.lastInsertRowid);
    this.insertInputs(jobId, inputs, now);
    const job = this.getJob(jobId);
    if (!job) throw new Error("Failed to create media job");
    return job;
  }

  private validateInputs(inputs: readonly MediaInput[]): void {
    const positions = new Set<number>();
    for (const input of inputs) {
      if (!Number.isSafeInteger(input.position) || input.position < 0) {
        throw new TypeError("media input position must be a non-negative safe integer");
      }
      if (positions.has(input.position)) throw new TypeError("media input positions must be unique");
      positions.add(input.position);
      requireSafeInteger(input.messageId, "media input messageId");
      requireNonEmpty(input.fileId, "media input fileId");
    }
  }

  private insertInputs(jobId: number, inputs: readonly MediaInput[], createdAt: string): void {
    const statement = this.database.prepare(`
      INSERT INTO mia_media_job_inputs (
        job_id, position, message_id, file_id, file_unique_id, input_type,
        mime_type, media_group_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const input of inputs) {
      statement.run(
        jobId,
        input.position,
        input.messageId,
        input.fileId,
        input.fileUniqueId,
        input.type,
        input.mimeType,
        input.mediaGroupId,
        createdAt,
      );
    }
  }

  private activeJobCount(telegramUserId: number): number {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM mia_media_jobs
      WHERE telegram_user_id = ? AND status IN (${placeholders})
    `).get(telegramUserId, ...ACTIVE_STATUSES) as CountRow;
    return row.count;
  }

  savePendingIntent(input: PendingIntentInput): PendingIntent {
    const threadId = validateCoordinates(input);
    if (input.missingRequired.some((field) => field.trim().length === 0)) {
      throw new TypeError("missingRequired fields must not be empty");
    }
    for (const messageId of input.sourceMessageIds) requireSafeInteger(messageId, "sourceMessageId");
    const now = this.timestamp();
    const expiresAt = this.after(this.pendingIntentTtlMs);
    this.database.prepare(`
      INSERT INTO mia_pending_intents (
        telegram_user_id, chat_id, thread_id, intent, slots_json,
        missing_required_json, source_message_ids_json, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_user_id, chat_id, thread_id) DO UPDATE SET
        intent = excluded.intent,
        slots_json = excluded.slots_json,
        missing_required_json = excluded.missing_required_json,
        source_message_ids_json = excluded.source_message_ids_json,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `).run(
      input.telegramUserId,
      input.chatId,
      threadId,
      input.intent,
      JSON.stringify(input.slots),
      JSON.stringify(input.missingRequired),
      JSON.stringify(input.sourceMessageIds),
      now,
      now,
      expiresAt,
    );
    const pending = this.getPendingIntent(input);
    if (!pending) throw new Error("Failed to save pending intent");
    return pending;
  }

  claimTelegramUpdate(updateId: number): boolean {
    if (!Number.isSafeInteger(updateId) || updateId < 0) throw new TypeError("updateId must be a non-negative safe integer");
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO mia_processed_updates (update_id, created_at, expires_at)
      VALUES (?, ?, ?)
    `).run(updateId, this.timestamp(), this.after(this.retentionTtlMs));
    return result.changes > 0;
  }

  getPendingIntent(scope: ConversationCoordinates): PendingIntent | null {
    const threadId = validateCoordinates(scope);
    const now = this.timestamp();
    const row = this.database.prepare(`
      SELECT * FROM mia_pending_intents
      WHERE telegram_user_id = ? AND chat_id = ? AND thread_id = ? AND expires_at > ?
    `).get(scope.telegramUserId, scope.chatId, threadId, now) as PendingIntentRow | undefined;
    if (row) return pendingIntentFromRow(row);
    this.database.prepare(`
      DELETE FROM mia_pending_intents
      WHERE telegram_user_id = ? AND chat_id = ? AND thread_id = ? AND expires_at <= ?
    `).run(scope.telegramUserId, scope.chatId, threadId, now);
    return null;
  }

  clearPendingIntent(scope: ConversationCoordinates): boolean {
    const threadId = validateCoordinates(scope);
    return this.database.prepare(`
      DELETE FROM mia_pending_intents
      WHERE telegram_user_id = ? AND chat_id = ? AND thread_id = ?
    `).run(scope.telegramUserId, scope.chatId, threadId).changes > 0;
  }

  createDraft(input: NewMediaJobInput, inputs: readonly MediaInput[] = []): MediaJob {
    const transaction = this.database.transaction(() => {
      const existing = this.getJobByIdempotencyKey(input.idempotencyKey);
      return existing ?? this.insertJob(input, "draft", inputs);
    });
    return transaction.immediate();
  }

  claimJob(
    input: NewMediaJobInput,
    inputs: readonly MediaInput[] = [],
    maxActiveJobs = DEFAULT_ACTIVE_JOB_LIMIT,
  ): ClaimMediaJobResult {
    if (!Number.isSafeInteger(maxActiveJobs) || maxActiveJobs < 1) {
      throw new RangeError("maxActiveJobs must be a positive safe integer");
    }
    this.validateNewJob(input);
    this.validateInputs(inputs);
    const transaction = this.database.transaction((): ClaimMediaJobResult => {
      const existing = this.getJobByIdempotencyKey(input.idempotencyKey);
      if (existing) return { outcome: "existing", job: existing };
      const activeCount = this.activeJobCount(input.telegramUserId);
      if (activeCount >= maxActiveJobs) return { outcome: "limit_reached", activeCount };
      return { outcome: "created", job: this.insertJob(input, "queued", inputs) };
    });
    return transaction.immediate();
  }

  claimDraft(jobId: number, maxActiveJobs = DEFAULT_ACTIVE_JOB_LIMIT): ClaimMediaDraftResult {
    requireSafeInteger(jobId, "jobId");
    if (!Number.isSafeInteger(maxActiveJobs) || maxActiveJobs < 1) {
      throw new RangeError("maxActiveJobs must be a positive safe integer");
    }
    const transaction = this.database.transaction((): ClaimMediaDraftResult => {
      const job = this.getJob(jobId);
      if (!job) return { outcome: "not_found" };
      if (job.status !== "draft") return { outcome: "already_claimed", job };
      const now = this.timestamp();
      if (job.deadlineAt <= now) {
        const expired = this.transitionJob(job.id, ["draft"], "expired");
        if (!expired) throw new Error("Failed to expire media draft");
        return { outcome: "expired", job: expired };
      }
      const activeCount = this.activeJobCount(job.telegramUserId);
      if (activeCount >= maxActiveJobs) return { outcome: "limit_reached", activeCount };
      const deadlineAt = new Date(this.now().getTime() + this.jobTimeout(job.type)).toISOString();
      this.database.prepare(`
        UPDATE mia_media_jobs
        SET status = 'queued', updated_at = ?, deadline_at = ?
        WHERE id = ? AND status = 'draft'
      `).run(now, deadlineAt, job.id);
      const claimed = this.getJob(job.id);
      if (!claimed) throw new Error("Failed to claim media draft");
      return { outcome: "claimed", job: claimed };
    });
    return transaction.immediate();
  }

  getJob(jobId: number): MediaJob | null {
    requireSafeInteger(jobId, "jobId");
    const row = this.database.prepare("SELECT * FROM mia_media_jobs WHERE id = ?").get(jobId) as
      | MediaJobRow
      | undefined;
    return row ? mediaJobFromRow(row) : null;
  }

  recordAgentDelivery(jobId: number, messageId: number, fileId: string | null, uniqueId: string | null): void {
    const job = this.getJob(jobId);
    if (!job?.options.agentRunId || job.status !== "succeeded") throw new Error("Agent artifact is not ready");
    this.database.prepare(`UPDATE mia_media_jobs SET status_message_id=?, result_telegram_file_id=?, result_telegram_unique_id=? WHERE id=? AND status='succeeded'`)
      .run(messageId, fileId, uniqueId, jobId);
  }

  getJobByIdempotencyKey(idempotencyKey: string): MediaJob | null {
    requireNonEmpty(idempotencyKey, "idempotencyKey");
    const row = this.database.prepare(
      "SELECT * FROM mia_media_jobs WHERE idempotency_key = ?",
    ).get(idempotencyKey) as MediaJobRow | undefined;
    return row ? mediaJobFromRow(row) : null;
  }

  saveLocalResult(jobId: number, bytes: Uint8Array): void {
    requireSafeInteger(jobId, "jobId");
    if (!this.getJob(jobId)) throw new Error("Media job not found");
    if (!this.resultDirectory) throw new Error("Local media result storage is not configured");
    const destination = this.localResultPath(jobId);
    const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
      renameSync(temporary, destination);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch (cleanupError) {
        if (!isMissingFile(cleanupError)) throw cleanupError;
      }
      throw error;
    }
  }

  getLocalResult(jobId: number, mimeType: string | null): LocalMediaResult | null {
    requireSafeInteger(jobId, "jobId");
    if (!this.resultDirectory) return null;
    const path = this.localResultPath(jobId);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) return null;
      const normalizedMimeType = mimeType?.trim() || "application/octet-stream";
      return {
        path,
        size: stat.size,
        mimeType: normalizedMimeType,
        filename: localResultFilename(normalizedMimeType),
      };
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  readLocalResult(jobId: number, mimeType: string | null): (LocalMediaResult & { bytes: Uint8Array }) | null {
    const result = this.getLocalResult(jobId, mimeType);
    return result ? { ...result, bytes: readFileSync(result.path) } : null;
  }

  listJobInputs(jobId: number): StoredMediaInput[] {
    requireSafeInteger(jobId, "jobId");
    const rows = this.database.prepare(`
      SELECT * FROM mia_media_job_inputs WHERE job_id = ? ORDER BY position ASC
    `).all(jobId) as MediaInputRow[];
    return rows.map(mediaInputFromRow);
  }

  replaceJobInputs(jobId: number, inputs: readonly MediaInput[]): StoredMediaInput[] {
    requireSafeInteger(jobId, "jobId");
    this.validateInputs(inputs);
    const transaction = this.database.transaction(() => {
      const job = this.getJob(jobId);
      if (!job) throw new Error("Media job not found");
      if (job.status !== "draft" && job.status !== "queued") {
        throw new Error("Media inputs cannot be changed after submission starts");
      }
      this.database.prepare("DELETE FROM mia_media_job_inputs WHERE job_id = ?").run(jobId);
      this.insertInputs(jobId, inputs, this.timestamp());
    });
    transaction.immediate();
    return this.listJobInputs(jobId);
  }

  updateDraft(jobId: number, options: Record<string, unknown>, statusMessageId?: number): MediaJob | null {
    requireSafeInteger(jobId, "jobId");
    if (statusMessageId !== undefined) requireSafeInteger(statusMessageId, "statusMessageId");
    const result = this.database.prepare(`
      UPDATE mia_media_jobs SET options_json = ?, status_message_id = COALESCE(?, status_message_id), updated_at = ?
      WHERE id = ? AND status = 'draft' AND deadline_at > ?
    `).run(JSON.stringify(options), statusMessageId ?? null, this.timestamp(), jobId, this.timestamp());
    return result.changes === 0 ? null : this.getJob(jobId);
  }

  saveTelegramMedia(chatId: number, threadId: number | null, input: MediaInput): TelegramMediaReference {
    requireSafeInteger(chatId, "chatId", true);
    const normalizedThreadId = normalizeThreadId(threadId);
    this.validateInputs([{ ...input, position: 0 }]);
    const now = this.timestamp();
    const expiresAt = this.after(this.retentionTtlMs);
    this.database.prepare(`
      INSERT INTO mia_telegram_media_refs (
        chat_id, message_id, thread_id, position, file_id, file_unique_id,
        input_type, mime_type, media_group_id, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, message_id) DO UPDATE SET
        thread_id = excluded.thread_id, position = excluded.position, file_id = excluded.file_id,
        file_unique_id = excluded.file_unique_id, input_type = excluded.input_type,
        mime_type = excluded.mime_type, media_group_id = excluded.media_group_id,
        expires_at = excluded.expires_at
    `).run(chatId, input.messageId, normalizedThreadId, input.position, input.fileId,
      input.fileUniqueId, input.type, input.mimeType, input.mediaGroupId, now, expiresAt);
    return { ...input, chatId, threadId, createdAt: now, expiresAt };
  }

  getTelegramMedia(chatId: number, messageId: number): TelegramMediaReference[] {
    requireSafeInteger(chatId, "chatId", true);
    requireSafeInteger(messageId, "messageId");
    const now = this.timestamp();
    const anchor = this.database.prepare(`
      SELECT * FROM mia_telegram_media_refs WHERE chat_id = ? AND message_id = ? AND expires_at > ?
    `).get(chatId, messageId, now) as (MediaInputRow & { chat_id: number; thread_id: number; expires_at: string }) | undefined;
    if (!anchor) return [];
    const rows = anchor.media_group_id
      ? this.database.prepare(`
          SELECT * FROM mia_telegram_media_refs
          WHERE chat_id = ? AND thread_id = ? AND media_group_id = ? AND expires_at > ?
          ORDER BY message_id ASC
        `).all(chatId, anchor.thread_id, anchor.media_group_id, now)
      : [anchor];
    return (rows as Array<MediaInputRow & { chat_id: number; thread_id: number; expires_at: string }>).map((row, index) => ({
      position: index,
      messageId: row.message_id,
      fileId: row.file_id,
      fileUniqueId: row.file_unique_id,
      type: row.input_type,
      mimeType: row.mime_type,
      mediaGroupId: row.media_group_id,
      chatId: row.chat_id,
      threadId: row.thread_id === NO_THREAD ? null : row.thread_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  }

  countActiveJobs(telegramUserId: number): number {
    requireSafeInteger(telegramUserId, "telegramUserId");
    return this.activeJobCount(telegramUserId);
  }

  listResumableJobs(limit = 100): MediaJob[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("limit must be between 1 and 1000");
    }
    const placeholders = RESUMABLE_STATUSES.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT * FROM mia_media_jobs
      WHERE status IN (${placeholders}) AND deadline_at > ?
      ORDER BY id ASC LIMIT ?
    `).all(...RESUMABLE_STATUSES, this.timestamp(), limit) as MediaJobRow[];
    return rows.map(mediaJobFromRow);
  }

  listTimedOutJobs(limit = 100): MediaJob[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("limit must be between 1 and 1000");
    const placeholders = RESUMABLE_STATUSES.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT * FROM mia_media_jobs
      WHERE status IN ('draft', ${placeholders}) AND deadline_at <= ?
      ORDER BY id ASC LIMIT ?
    `).all(...RESUMABLE_STATUSES, this.timestamp(), limit) as MediaJobRow[];
    return rows.map(mediaJobFromRow);
  }

  listRetentionExpiredJobs(limit = 100): MediaJob[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("limit must be between 1 and 1000");
    const rows = this.database.prepare(`
      SELECT * FROM mia_media_jobs
      WHERE status IN ('succeeded', 'failed', 'expired') AND retention_expires_at <= ?
        AND (result_url IS NOT NULL OR result_telegram_file_id IS NOT NULL)
      ORDER BY id ASC LIMIT ?
    `).all(this.timestamp(), limit) as MediaJobRow[];
    return rows.map(mediaJobFromRow);
  }

  transitionJob(
    jobId: number,
    expectedStatuses: readonly MediaJobStatus[],
    nextStatus: MediaJobStatus,
    patch: MediaJobTransitionPatch = {},
  ): MediaJob | null {
    requireSafeInteger(jobId, "jobId");
    if (expectedStatuses.length === 0) throw new TypeError("expectedStatuses must not be empty");
    for (const status of expectedStatuses) {
      if (!ALLOWED_TRANSITIONS[status].includes(nextStatus)) {
        throw new Error(`Invalid media job transition: ${status} -> ${nextStatus}`);
      }
    }
    if (patch.statusMessageId !== undefined && patch.statusMessageId !== null) {
      requireSafeInteger(patch.statusMessageId, "statusMessageId");
    }
    if (patch.progress !== undefined && patch.progress !== null &&
      (!Number.isFinite(patch.progress) || patch.progress < 0 || patch.progress > 100)) {
      throw new RangeError("progress must be between 0 and 100");
    }
    const now = this.timestamp();
    const isSubmitted = nextStatus === "submitted";
    const isTerminal = TERMINAL_STATUSES.includes(nextStatus as (typeof TERMINAL_STATUSES)[number]);
    const retentionExpiresAt = isTerminal
      ? new Date(this.now().getTime() + this.retentionTtlMs).toISOString()
      : null;
    const placeholders = expectedStatuses.map(() => "?").join(", ");
    const result = this.database.prepare(`
      UPDATE mia_media_jobs SET
        status = ?,
        status_message_id = COALESCE(?, status_message_id),
        upstream_task_id = COALESCE(?, upstream_task_id),
        progress = COALESCE(?, progress),
        result_url = COALESCE(?, result_url),
        result_mime_type = COALESCE(?, result_mime_type),
        result_telegram_file_id = COALESCE(?, result_telegram_file_id),
        result_telegram_unique_id = COALESCE(?, result_telegram_unique_id),
        error_code = COALESCE(?, error_code),
        error_message = COALESCE(?, error_message),
        submitted_at = CASE WHEN ? THEN COALESCE(submitted_at, ?) ELSE submitted_at END,
        completed_at = CASE WHEN ? THEN COALESCE(completed_at, ?) ELSE completed_at END,
        retention_expires_at = COALESCE(?, retention_expires_at),
        updated_at = ?
      WHERE id = ? AND status IN (${placeholders})
    `).run(
      nextStatus,
      patch.statusMessageId ?? null,
      patch.upstreamTaskId ?? null,
      patch.progress ?? null,
      patch.resultUrl ?? null,
      patch.resultMimeType ?? null,
      patch.resultTelegramFileId ?? null,
      patch.resultTelegramUniqueId ?? null,
      patch.errorCode ?? null,
      patch.errorMessage ?? null,
      isSubmitted ? 1 : 0,
      now,
      isTerminal ? 1 : 0,
      now,
      retentionExpiresAt,
      now,
      jobId,
      ...expectedStatuses,
    ) as ChangesResult;
    return result.changes === 0 ? null : this.getJob(jobId);
  }

  setActivePrivateImage(input: ActivePrivateImageInput): ActivePrivateImage {
    requireSafeInteger(input.telegramUserId, "telegramUserId");
    requireSafeInteger(input.chatId, "chatId");
    requireSafeInteger(input.messageId, "messageId");
    requireNonEmpty(input.fileId, "fileId");
    const now = this.timestamp();
    const expiresAt = this.after(this.activeImageTtlMs);
    this.database.prepare(`
      INSERT INTO mia_private_active_images (
        telegram_user_id, chat_id, message_id, file_id, file_unique_id,
        input_type, mime_type, media_group_id, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_user_id, chat_id) DO UPDATE SET
        message_id = excluded.message_id,
        file_id = excluded.file_id,
        file_unique_id = excluded.file_unique_id,
        input_type = excluded.input_type,
        mime_type = excluded.mime_type,
        media_group_id = excluded.media_group_id,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `).run(
      input.telegramUserId,
      input.chatId,
      input.messageId,
      input.fileId,
      input.fileUniqueId,
      input.type,
      input.mimeType,
      input.mediaGroupId,
      now,
      now,
      expiresAt,
    );
    const current = this.getActivePrivateImage(input.telegramUserId, input.chatId);
    if (!current) throw new Error("Failed to save active private image");
    return current;
  }

  getActivePrivateImage(telegramUserId: number, chatId: number): ActivePrivateImage | null {
    requireSafeInteger(telegramUserId, "telegramUserId");
    requireSafeInteger(chatId, "chatId");
    const now = this.timestamp();
    const row = this.database.prepare(`
      SELECT * FROM mia_private_active_images
      WHERE telegram_user_id = ? AND chat_id = ? AND expires_at > ?
    `).get(telegramUserId, chatId, now) as ActiveImageRow | undefined;
    if (row) return activeImageFromRow(row);
    this.database.prepare(`
      DELETE FROM mia_private_active_images
      WHERE telegram_user_id = ? AND chat_id = ? AND expires_at <= ?
    `).run(telegramUserId, chatId, now);
    return null;
  }

  clearActivePrivateImage(telegramUserId: number, chatId: number): boolean {
    requireSafeInteger(telegramUserId, "telegramUserId");
    requireSafeInteger(chatId, "chatId");
    return this.database.prepare(`
      DELETE FROM mia_private_active_images WHERE telegram_user_id = ? AND chat_id = ?
    `).run(telegramUserId, chatId).changes > 0;
  }

  isGroupMediaEnabled(chatId: number): boolean {
    requireSafeInteger(chatId, "chatId", true);
    const row = this.database.prepare(
      "SELECT enabled FROM mia_group_media_settings WHERE chat_id = ?",
    ).get(chatId) as { enabled: number } | undefined;
    return row?.enabled !== 0;
  }

  setGroupMediaEnabled(chatId: number, enabled: boolean): void {
    requireSafeInteger(chatId, "chatId", true);
    this.database.prepare(`
      INSERT INTO mia_group_media_settings (chat_id, enabled, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
    `).run(chatId, enabled ? 1 : 0, this.timestamp());
  }

  createAccessToken(kind: MediaAccessTokenKind, jobId: number): MediaAccessToken {
    requireSafeInteger(jobId, "jobId");
    const job = this.getJob(jobId);
    if (!job) throw new Error("Media job not found");
    const now = this.timestamp();
    const expiresAt = this.after(this.retentionTtlMs);
    for (let attempts = 0; attempts < 3; attempts += 1) {
      const token = randomBytes(32).toString("base64url");
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO mia_media_access_tokens (
          token, token_kind, job_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(token, kind, jobId, now, expiresAt);
      if (result.changes > 0) return { token, kind, jobId, createdAt: now, expiresAt };
    }
    throw new Error("Failed to create a unique media access token");
  }

  getAccessToken(token: string, kind?: MediaAccessTokenKind): MediaAccessToken | null {
    requireNonEmpty(token, "token");
    const now = this.timestamp();
    const row = this.database.prepare(`
      SELECT * FROM mia_media_access_tokens
      WHERE token = ? AND expires_at > ? AND (? IS NULL OR token_kind = ?)
    `).get(token, now, kind ?? null, kind ?? null) as AccessTokenRow | undefined;
    if (row) return accessTokenFromRow(row);
    this.database.prepare(
      "DELETE FROM mia_media_access_tokens WHERE token = ? AND expires_at <= ?",
    ).run(token, now);
    return null;
  }

  revokeAccessToken(token: string): boolean {
    requireNonEmpty(token, "token");
    return this.database.prepare("DELETE FROM mia_media_access_tokens WHERE token = ?").run(token)
      .changes > 0;
  }

  cleanupExpired(): MediaCleanupResult {
    const now = this.timestamp();
    return this.database.transaction(() => {
      const pendingIntentsDeleted = this.database.prepare(
        "DELETE FROM mia_pending_intents WHERE expires_at <= ?",
      ).run(now).changes;
      const activeImagesDeleted = this.database.prepare(
        "DELETE FROM mia_private_active_images WHERE expires_at <= ?",
      ).run(now).changes;
      const accessTokensDeleted = this.database.prepare(
        "DELETE FROM mia_media_access_tokens WHERE expires_at <= ?",
      ).run(now).changes;
      this.database.prepare("DELETE FROM mia_processed_updates WHERE expires_at <= ?").run(now);
      this.database.prepare("DELETE FROM mia_telegram_media_refs WHERE expires_at <= ?").run(now);

      const expiredRows = this.database.prepare(`
        SELECT id FROM mia_media_jobs
        WHERE status IN ('draft', 'queued', 'submitting', 'submitted', 'in_progress')
          AND deadline_at <= ?
      `).all(now) as Array<{ id: number }>;
      const terminalRetention = new Date(this.now().getTime() + this.retentionTtlMs).toISOString();
      const expireStatement = this.database.prepare(`
        UPDATE mia_media_jobs
        SET status = 'expired', completed_at = COALESCE(completed_at, ?),
            updated_at = ?, retention_expires_at = ?
        WHERE id = ? AND status IN ('draft', 'queued', 'submitting', 'submitted', 'in_progress')
      `);
      for (const row of expiredRows) expireStatement.run(now, now, terminalRetention, row.id);

      const retainedRows = this.database.prepare(`
        SELECT id FROM mia_media_jobs
        WHERE status IN ('succeeded', 'failed', 'expired') AND retention_expires_at <= ?
      `).all(now) as Array<{ id: number }>;
      let inputRowsDeleted = 0;
      const deleteInputs = this.database.prepare("DELETE FROM mia_media_job_inputs WHERE job_id = ?");
      const clearMedia = this.database.prepare(`
        UPDATE mia_media_jobs SET
          result_url = NULL,
          result_mime_type = NULL,
          result_telegram_file_id = NULL,
          result_telegram_unique_id = NULL,
          updated_at = ?
        WHERE id = ?
      `);
      for (const row of retainedRows) {
        this.deleteLocalResult(row.id);
        inputRowsDeleted += deleteInputs.run(row.id).changes;
        this.database.prepare("DELETE FROM mia_media_access_tokens WHERE job_id = ?").run(row.id);
        clearMedia.run(now, row.id);
      }

      return {
        pendingIntentsDeleted,
        activeImagesDeleted,
        accessTokensDeleted,
        jobsExpired: expiredRows.length,
        jobsMediaCleared: retainedRows.length,
        inputRowsDeleted,
      } satisfies MediaCleanupResult;
    }).immediate();
  }

  private localResultPath(jobId: number): string {
    if (!this.resultDirectory) throw new Error("Local media result storage is not configured");
    return join(this.resultDirectory, String(jobId));
  }

  private deleteLocalResult(jobId: number): void {
    if (!this.resultDirectory) return;
    try {
      unlinkSync(this.localResultPath(jobId));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function localResultFilename(mimeType: string): string {
  if (mimeType === "image/png") return "mia-image.png";
  if (mimeType === "image/jpeg") return "mia-image.jpg";
  if (mimeType === "image/webp") return "mia-image.webp";
  if (mimeType === "video/mp4") return "mia-video.mp4";
  return "mia-media.bin";
}
