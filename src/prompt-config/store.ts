import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { PROMPT_LIBRARY, type PromptDefinition } from "../prompts.js";

export class InvalidPromptTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPromptTextError";
  }
}

function validatePromptText(id: string, value: unknown): string {
  if (typeof value !== "string") throw new InvalidPromptTextError("Prompt must be text");
  const text = value.trim();
  if (!text) throw new InvalidPromptTextError("Prompt cannot be empty");
  if (text.length > 100_000) throw new InvalidPromptTextError("Prompt is too long");
  if ([...text].some((character) => {
    const code = character.charCodeAt(0);
    return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
  })) {
    throw new InvalidPromptTextError("Prompt contains unsupported control characters");
  }
  if (id === "mia.response-schema") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new InvalidPromptTextError("Response Schema must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        (parsed as Record<string, unknown>).type !== "object") {
      throw new InvalidPromptTextError("Response Schema must be a JSON Schema object");
    }
  }
  return text;
}

export class PromptConfigStore {
  private readonly database: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS prompt_configs (
        prompt_id TEXT PRIMARY KEY,
        prompt_text TEXT NOT NULL
      );
    `);
    this.database.prepare(
      "DELETE FROM prompt_configs WHERE prompt_id IN ('mia.group-summary', 'mia.group-summary-input')",
    ).run();
    const insert = this.database.prepare(
      "INSERT OR IGNORE INTO prompt_configs (prompt_id, prompt_text) VALUES (?, ?)",
    );
    const seed = this.database.transaction(() => {
      for (const prompt of PROMPT_LIBRARY) insert.run(prompt.id, prompt.text);
    });
    seed();
  }

  get(id: string): string | undefined {
    const row = this.database.prepare("SELECT prompt_text FROM prompt_configs WHERE prompt_id = ?").get(id) as
      { prompt_text: string } | undefined;
    return row?.prompt_text;
  }

  list(): PromptDefinition[] {
    const rows = this.database.prepare("SELECT prompt_id, prompt_text FROM prompt_configs").all() as
      Array<{ prompt_id: string; prompt_text: string }>;
    const values = new Map(rows.map((row) => [row.prompt_id, row.prompt_text]));
    return PROMPT_LIBRARY.map((prompt) => ({ ...prompt, text: values.get(prompt.id) ?? prompt.text }));
  }

  save(id: string, value: unknown): PromptDefinition {
    const prompt = PROMPT_LIBRARY.find((item) => item.id === id);
    if (!prompt) throw new InvalidPromptTextError("Unknown Prompt");
    const text = validatePromptText(id, value);
    this.database.prepare(
      "INSERT INTO prompt_configs (prompt_id, prompt_text) VALUES (?, ?) ON CONFLICT(prompt_id) DO UPDATE SET prompt_text = excluded.prompt_text",
    ).run(id, text);
    return { ...prompt, text };
  }

  close(): void {
    this.database.close();
  }
}
