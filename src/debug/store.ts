import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { sanitizeDebugValue } from "./sanitize.js";
import type { DebugRequest, FinishDebugRequest, StartDebugRequest } from "./types.js";

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_PER_USER = 100;

interface DebugRequestRow {
  public_id: string;
  telegram_user_id: number;
  chat_id: number | null;
  chat_type: string | null;
  message_id: number | null;
  request_kind: DebugRequest["kind"];
  model: string;
  status: DebugRequest["status"];
  duration_ms: number | null;
  prompt_refs_json: string;
  context_layers_json: string | null;
  request_preview_json: string | null;
  response_preview_json: string | null;
  media_json: string | null;
  details_json: string | null;
  task_id: string | null;
  error_code: string | null;
  created_at: string;
  completed_at: string | null;
}

function json(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(sanitizeDebugValue(value));
}

function parsed(value: string | null): unknown {
  return value === null ? null : JSON.parse(value) as unknown;
}

function fromRow(row: DebugRequestRow): DebugRequest {
  return {
    id: row.public_id,
    telegramUserId: row.telegram_user_id,
    chatId: row.chat_id,
    chatType: row.chat_type,
    messageId: row.message_id,
    kind: row.request_kind,
    model: row.model,
    status: row.status,
    durationMs: row.duration_ms,
    promptRefs: parsed(row.prompt_refs_json) as DebugRequest["promptRefs"],
    contextLayers: parsed(row.context_layers_json) as DebugRequest["contextLayers"],
    requestPreview: parsed(row.request_preview_json),
    responsePreview: parsed(row.response_preview_json),
    media: parsed(row.media_json),
    details: parsed(row.details_json),
    taskId: row.task_id,
    errorCode: row.error_code,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export class DebugStore {
  private readonly database: Database.Database;
  private readonly retentionMs: number;
  private readonly maxPerUser: number;

  constructor(path: string, options: { retentionMs?: number; maxPerUser?: number } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxPerUser = options.maxPerUser ?? DEFAULT_MAX_PER_USER;
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS debug_requests (
        public_id TEXT PRIMARY KEY,
        external_key TEXT UNIQUE,
        telegram_user_id INTEGER NOT NULL,
        chat_id INTEGER,
        chat_type TEXT,
        message_id INTEGER,
        request_kind TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER,
        prompt_refs_json TEXT NOT NULL,
        context_layers_json TEXT,
        request_preview_json TEXT,
        response_preview_json TEXT,
        media_json TEXT,
        details_json TEXT,
        task_id TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_debug_requests_user_created
        ON debug_requests(telegram_user_id, created_at DESC);
    `);
  }

  start(input: StartDebugRequest): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO debug_requests (
        public_id, external_key, telegram_user_id, chat_id, chat_type, message_id,
        request_kind, model, status, prompt_refs_json, context_layers_json,
        request_preview_json, media_json, details_json, task_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_key) DO UPDATE SET
        status = 'running', request_kind = excluded.request_kind, model = excluded.model,
        request_preview_json = excluded.request_preview_json, media_json = excluded.media_json,
        details_json = excluded.details_json, task_id = excluded.task_id, created_at = excluded.created_at,
        completed_at = NULL, duration_ms = NULL, error_code = NULL
    `).run(
      id, input.externalKey ?? null, input.telegramUserId, input.chatId ?? null,
      input.chatType ?? null, input.messageId ?? null, input.kind, input.model,
      json(input.promptRefs ?? []) ?? "[]", json(input.contextLayers), json(input.requestPreview),
      json(input.media), json(input.details), input.taskId ?? null, now,
    );
    const stored = input.externalKey
      ? this.database.prepare("SELECT public_id FROM debug_requests WHERE external_key = ?").get(input.externalKey) as { public_id: string }
      : { public_id: id };
    this.cleanup(input.telegramUserId);
    return stored.public_id;
  }

  finish(id: string, input: FinishDebugRequest): void {
    const row = this.database.prepare("SELECT created_at FROM debug_requests WHERE public_id = ?").get(id) as { created_at: string } | undefined;
    if (!row) return;
    const completedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(row.created_at));
    this.database.prepare(`
      UPDATE debug_requests SET
        status = ?, duration_ms = ?, response_preview_json = COALESCE(?, response_preview_json),
        details_json = COALESCE(?, details_json), task_id = COALESCE(?, task_id),
        error_code = ?, request_kind = COALESCE(?, request_kind), completed_at = ?
      WHERE public_id = ?
    `).run(
      input.status, durationMs, json(input.responsePreview), json(input.details),
      input.taskId ?? null, input.errorCode ?? null, input.kind ?? null, completedAt, id,
    );
  }

  list(telegramUserId: number, limit = 100): DebugRequest[] {
    this.cleanup(telegramUserId);
    const rows = this.database.prepare(`
      SELECT * FROM debug_requests WHERE telegram_user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(telegramUserId, Math.max(1, Math.min(limit, this.maxPerUser))) as DebugRequestRow[];
    return rows.map(fromRow);
  }

  get(telegramUserId: number, id: string): DebugRequest | null {
    const row = this.database.prepare(`
      SELECT * FROM debug_requests WHERE telegram_user_id = ? AND public_id = ?
    `).get(telegramUserId, id) as DebugRequestRow | undefined;
    return row ? fromRow(row) : null;
  }

  clear(telegramUserId: number): number {
    return this.database.prepare("DELETE FROM debug_requests WHERE telegram_user_id = ?").run(telegramUserId).changes;
  }

  close(): void {
    this.database.close();
  }

  private cleanup(telegramUserId: number): void {
    const cutoff = new Date(Date.now() - this.retentionMs).toISOString();
    this.database.prepare("DELETE FROM debug_requests WHERE created_at < ?").run(cutoff);
    this.database.prepare(`
      DELETE FROM debug_requests WHERE telegram_user_id = ? AND public_id NOT IN (
        SELECT public_id FROM debug_requests WHERE telegram_user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
      )
    `).run(telegramUserId, telegramUserId, this.maxPerUser);
  }
}
