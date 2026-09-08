import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Update } from "grammy/types";
import type { AgentInput, Run } from "./types.js";

// A single-process scheduler owns run writes. Transactions protect checkpoints
// and inbox consumption; remote submissions still require their own idempotency.
export class AgentStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, scope TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_runs_scope ON agent_runs(scope);
      CREATE TABLE IF NOT EXISTS agent_inputs (key TEXT PRIMARY KEY, payload TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE IF NOT EXISTS agent_updates (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE IF NOT EXISTS agent_deliveries (key TEXT PRIMARY KEY, status TEXT NOT NULL, message_id INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
    `);
  }
  close(): void { this.db.close(); }
  save(run: Run): void {
    run.updatedAt = Date.now();
    this.db.prepare("INSERT INTO agent_runs VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload")
      .run(run.id, run.scope, run.status, JSON.stringify(run));
  }
  get(id: string): Run | null {
    const row = this.db.prepare("SELECT payload FROM agent_runs WHERE id=?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as Run : null;
  }
  list(): Run[] {
    return (this.db.prepare("SELECT payload FROM agent_runs WHERE status NOT IN ('completed','cancelled') ORDER BY rowid").all() as { payload: string }[])
      .map(row => JSON.parse(row.payload) as Run);
  }
  enqueue(input: AgentInput): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO agent_inputs(key,payload) VALUES (?,?)").run(input.key, JSON.stringify(input)).changes > 0;
  }
  inputs(): AgentInput[] {
    return (this.db.prepare("SELECT payload FROM agent_inputs WHERE consumed=0 ORDER BY rowid").all() as { payload: string }[])
      .map(row => JSON.parse(row.payload) as AgentInput);
  }
  consume(input: AgentInput, runs: Run[]): void {
    this.db.transaction(() => {
      for (const run of runs) this.save(run);
      this.db.prepare("UPDATE agent_inputs SET consumed=1 WHERE key=?").run(input.key);
    })();
  }
  enqueueUpdate(update: Update): void {
    this.db.prepare("INSERT OR IGNORE INTO agent_updates(id,payload) VALUES (?,?)").run(update.update_id, JSON.stringify(update));
  }
  updates(): Update[] {
    return (this.db.prepare("SELECT payload FROM agent_updates WHERE consumed=0 ORDER BY id LIMIT 100").all() as { payload: string }[])
      .map(row => JSON.parse(row.payload) as Update);
  }
  consumeUpdate(id: number): void { this.db.prepare("UPDATE agent_updates SET consumed=1 WHERE id=?").run(id); }
  delivery(key: string): { status: string; message_id: number | null } | null {
    return this.db.prepare("SELECT status,message_id FROM agent_deliveries WHERE key=?").get(key) as { status: string; message_id: number | null } | undefined ?? null;
  }
  setDelivery(key: string, status: string, messageId: number | null = null): void {
    this.db.prepare("INSERT INTO agent_deliveries(key,status,message_id) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status,message_id=excluded.message_id")
      .run(key, status, messageId);
  }
  prune(): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM agent_updates WHERE consumed=1 AND created_at < unixepoch()-604800").run();
      this.db.prepare("DELETE FROM agent_inputs WHERE consumed=1 AND created_at < unixepoch()-604800").run();
      this.db.prepare("DELETE FROM agent_runs WHERE status IN ('completed','cancelled') AND json_extract(payload,'$.updatedAt') < ?").run(Date.now() - 7 * 86400_000);
      this.db.prepare("DELETE FROM agent_deliveries WHERE created_at < unixepoch()-604800 AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE substr(agent_deliveries.key,1,length(agent_runs.id))=agent_runs.id)").run();
    })();
  }
}
