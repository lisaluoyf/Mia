import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type {
  ChatInput,
  ChatMemberInput,
  ChatRecord,
  ConversationScope,
  MemoryInput,
  MemoryRecord,
  MemoryScope,
  MessageInput,
  StoredMessage,
  SummaryInput,
  SummaryRecord,
  UserProfile,
  UserProfileInput,
} from "./types.js";

const NO_THREAD = 0;

interface UserRow {
  telegram_user_id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  language_code: string | null;
  is_bot: number;
  created_at: string;
  updated_at: string;
}

interface ChatRow {
  chat_id: number;
  type: ChatRecord["type"];
  title: string | null;
  username: string | null;
  description: string | null;
  is_forum: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  chat_id: number;
  message_id: number;
  thread_id: number;
  sender_user_id: number | null;
  sender_chat_id: number | null;
  reply_to_message_id: number | null;
  content_type: string;
  text: string | null;
  caption: string | null;
  entities_json: string | null;
  media_file_id: string | null;
  media_unique_id: string | null;
  sent_at: string;
  edited_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ScopedRow {
  scope_type: MemoryScope["type"];
  user_id: number | null;
  chat_id: number | null;
  thread_id: number;
}

interface MemoryRow extends ScopedRow {
  id: number;
  category: string;
  content: string;
  source_message_id: number | null;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
}

interface SummaryRow extends ScopedRow {
  id: number;
  content: string;
  from_message_id: number | null;
  through_message_id: number;
  created_at: string;
}

interface ScopeQuery {
  type: MemoryScope["type"];
  userId: number | null;
  chatId: number | null;
  threadId: number;
}

function requireSafeInteger(value: number, name: string, allowNegative = false): void {
  if (!Number.isSafeInteger(value) || value === 0 || (!allowNegative && value < 0)) {
    throw new TypeError(`${name} must be a ${allowNegative ? "non-zero " : "positive "}safe integer`);
  }
}

function normalizeScope(scope: MemoryScope): ScopeQuery {
  switch (scope.type) {
    case "user":
      requireSafeInteger(scope.userId, "userId");
      return { type: scope.type, userId: scope.userId, chatId: null, threadId: NO_THREAD };
    case "private":
    case "group":
      requireSafeInteger(scope.chatId, "chatId", true);
      return { type: scope.type, userId: null, chatId: scope.chatId, threadId: NO_THREAD };
    case "topic":
      requireSafeInteger(scope.chatId, "chatId", true);
      requireSafeInteger(scope.threadId, "threadId");
      return { type: scope.type, userId: null, chatId: scope.chatId, threadId: scope.threadId };
  }
}

function conversationCoordinates(scope: ConversationScope): { chatId: number; threadId: number } {
  const normalized = normalizeScope(scope);
  if (normalized.chatId === null) {
    throw new TypeError("Conversation scope requires a chatId");
  }
  return { chatId: normalized.chatId, threadId: normalized.threadId };
}

function scopeFromRow(row: ScopedRow): MemoryScope {
  switch (row.scope_type) {
    case "user":
      if (row.user_id === null) throw new Error("Invalid stored user scope");
      return { type: "user", userId: row.user_id };
    case "private":
    case "group":
      if (row.chat_id === null) throw new Error("Invalid stored chat scope");
      return { type: row.scope_type, chatId: row.chat_id };
    case "topic":
      if (row.chat_id === null || row.thread_id === NO_THREAD) throw new Error("Invalid stored topic scope");
      return { type: "topic", chatId: row.chat_id, threadId: row.thread_id };
  }
}

function userFromRow(row: UserRow): UserProfile {
  return {
    telegramUserId: row.telegram_user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    username: row.username,
    languageCode: row.language_code,
    isBot: row.is_bot === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function chatFromRow(row: ChatRow): ChatRecord {
  return {
    chatId: row.chat_id,
    type: row.type,
    title: row.title,
    username: row.username,
    description: row.description,
    isForum: row.is_forum === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageFromRow(row: MessageRow): StoredMessage {
  return {
    chatId: row.chat_id,
    messageId: row.message_id,
    threadId: row.thread_id === NO_THREAD ? null : row.thread_id,
    senderUserId: row.sender_user_id,
    senderChatId: row.sender_chat_id,
    replyToMessageId: row.reply_to_message_id,
    contentType: row.content_type,
    text: row.text,
    caption: row.caption,
    entitiesJson: row.entities_json,
    mediaFileId: row.media_file_id,
    mediaUniqueId: row.media_unique_id,
    sentAt: row.sent_at,
    editedAt: row.edited_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function memoryFromRow(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    scope: scopeFromRow(row),
    category: row.category,
    content: row.content,
    sourceMessageId: row.source_message_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function summaryFromRow(row: SummaryRow): SummaryRecord {
  const scope = scopeFromRow(row);
  if (scope.type === "user") throw new Error("Invalid stored summary scope");
  return {
    id: row.id,
    scope,
    content: row.content,
    fromMessageId: row.from_message_id,
    throughMessageId: row.through_message_id,
    createdAt: row.created_at,
  };
}

export class ContextStore {
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS mia_users (
        telegram_user_id INTEGER PRIMARY KEY,
        first_name TEXT NOT NULL,
        last_name TEXT,
        username TEXT,
        language_code TEXT,
        is_bot INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS mia_chats (
        chat_id INTEGER PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('private', 'group', 'supergroup', 'channel')),
        title TEXT,
        username TEXT,
        description TEXT,
        is_forum INTEGER NOT NULL DEFAULT 0 CHECK (is_forum IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS mia_chat_members (
        chat_id INTEGER NOT NULL REFERENCES mia_chats(chat_id) ON DELETE CASCADE,
        telegram_user_id INTEGER NOT NULL REFERENCES mia_users(telegram_user_id) ON DELETE CASCADE,
        status TEXT,
        first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (chat_id, telegram_user_id)
      );

      CREATE TABLE IF NOT EXISTS mia_messages (
        chat_id INTEGER NOT NULL REFERENCES mia_chats(chat_id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL CHECK (message_id > 0),
        thread_id INTEGER NOT NULL DEFAULT 0 CHECK (thread_id >= 0),
        sender_user_id INTEGER REFERENCES mia_users(telegram_user_id) ON DELETE SET NULL,
        sender_chat_id INTEGER,
        reply_to_message_id INTEGER,
        content_type TEXT NOT NULL,
        text TEXT,
        caption TEXT,
        entities_json TEXT,
        media_file_id TEXT,
        media_unique_id TEXT,
        sent_at TEXT NOT NULL,
        edited_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (chat_id, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_mia_messages_context
        ON mia_messages(chat_id, thread_id, message_id DESC);
      CREATE INDEX IF NOT EXISTS idx_mia_messages_sender
        ON mia_messages(sender_user_id, sent_at DESC);

      CREATE TABLE IF NOT EXISTS mia_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('private', 'group', 'topic')),
        user_id INTEGER,
        chat_id INTEGER NOT NULL REFERENCES mia_chats(chat_id) ON DELETE CASCADE,
        thread_id INTEGER NOT NULL DEFAULT 0 CHECK (thread_id >= 0),
        content TEXT NOT NULL,
        from_message_id INTEGER,
        through_message_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (
          (scope_type IN ('private', 'group') AND user_id IS NULL AND thread_id = 0) OR
          (scope_type = 'topic' AND user_id IS NULL AND thread_id > 0)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_mia_summaries_scope
        ON mia_summaries(scope_type, chat_id, thread_id, through_message_id DESC);

      CREATE TABLE IF NOT EXISTS mia_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'private', 'group', 'topic')),
        user_id INTEGER REFERENCES mia_users(telegram_user_id) ON DELETE CASCADE,
        chat_id INTEGER REFERENCES mia_chats(chat_id) ON DELETE CASCADE,
        thread_id INTEGER NOT NULL DEFAULT 0 CHECK (thread_id >= 0),
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        source_message_id INTEGER,
        created_by_user_id INTEGER REFERENCES mia_users(telegram_user_id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (
          (scope_type = 'user' AND user_id IS NOT NULL AND chat_id IS NULL AND thread_id = 0) OR
          (scope_type IN ('private', 'group') AND user_id IS NULL AND chat_id IS NOT NULL AND thread_id = 0) OR
          (scope_type = 'topic' AND user_id IS NULL AND chat_id IS NOT NULL AND thread_id > 0)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_mia_memories_scope
        ON mia_memories(scope_type, user_id, chat_id, thread_id, created_at DESC);
    `);
  }

  upsertUser(input: UserProfileInput): UserProfile {
    requireSafeInteger(input.telegramUserId, "telegramUserId");
    this.database.prepare(`
      INSERT INTO mia_users (
        telegram_user_id, first_name, last_name, username, language_code, is_bot
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        username = excluded.username,
        language_code = excluded.language_code,
        is_bot = excluded.is_bot,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      input.telegramUserId,
      input.firstName,
      input.lastName,
      input.username,
      input.languageCode,
      input.isBot ? 1 : 0,
    );
    const user = this.getUser(input.telegramUserId);
    if (!user) throw new Error("Failed to store user profile");
    return user;
  }

  getUser(telegramUserId: number): UserProfile | null {
    requireSafeInteger(telegramUserId, "telegramUserId");
    const row = this.database.prepare(
      "SELECT * FROM mia_users WHERE telegram_user_id = ?",
    ).get(telegramUserId) as UserRow | undefined;
    return row ? userFromRow(row) : null;
  }

  upsertChat(input: ChatInput): ChatRecord {
    requireSafeInteger(input.chatId, "chatId", true);
    this.database.prepare(`
      INSERT INTO mia_chats (chat_id, type, title, username, description, is_forum)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        type = excluded.type,
        title = excluded.title,
        username = excluded.username,
        description = COALESCE(excluded.description, mia_chats.description),
        is_forum = excluded.is_forum,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      input.chatId,
      input.type,
      input.title,
      input.username,
      input.description,
      input.isForum ? 1 : 0,
    );
    const chat = this.getChat(input.chatId);
    if (!chat) throw new Error("Failed to store chat");
    return chat;
  }

  getChat(chatId: number): ChatRecord | null {
    requireSafeInteger(chatId, "chatId", true);
    const row = this.database.prepare("SELECT * FROM mia_chats WHERE chat_id = ?").get(chatId) as
      | ChatRow
      | undefined;
    return row ? chatFromRow(row) : null;
  }

  upsertMember(input: ChatMemberInput): void {
    requireSafeInteger(input.chatId, "chatId", true);
    requireSafeInteger(input.telegramUserId, "telegramUserId");
    this.database.prepare(`
      INSERT INTO mia_chat_members (chat_id, telegram_user_id, status)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id, telegram_user_id) DO UPDATE SET
        status = COALESCE(excluded.status, mia_chat_members.status),
        last_seen_at = CURRENT_TIMESTAMP
    `).run(input.chatId, input.telegramUserId, input.status);
  }

  saveMessage(input: MessageInput): StoredMessage {
    requireSafeInteger(input.chatId, "chatId", true);
    requireSafeInteger(input.messageId, "messageId");
    if (input.threadId !== null) requireSafeInteger(input.threadId, "threadId");
    if (input.senderUserId !== null) requireSafeInteger(input.senderUserId, "senderUserId");
    if (input.senderChatId !== null) requireSafeInteger(input.senderChatId, "senderChatId", true);
    if (input.replyToMessageId !== null) requireSafeInteger(input.replyToMessageId, "replyToMessageId");
    const threadId = input.threadId ?? NO_THREAD;
    this.database.prepare(`
      INSERT INTO mia_messages (
        chat_id, message_id, thread_id, sender_user_id, sender_chat_id,
        reply_to_message_id, content_type, text, caption, entities_json,
        media_file_id, media_unique_id, sent_at, edited_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, message_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        sender_user_id = excluded.sender_user_id,
        sender_chat_id = excluded.sender_chat_id,
        reply_to_message_id = excluded.reply_to_message_id,
        content_type = excluded.content_type,
        text = excluded.text,
        caption = excluded.caption,
        entities_json = excluded.entities_json,
        media_file_id = excluded.media_file_id,
        media_unique_id = excluded.media_unique_id,
        edited_at = COALESCE(excluded.edited_at, mia_messages.edited_at),
        updated_at = CURRENT_TIMESTAMP
    `).run(
      input.chatId,
      input.messageId,
      threadId,
      input.senderUserId,
      input.senderChatId,
      input.replyToMessageId,
      input.contentType,
      input.text,
      input.caption,
      input.entitiesJson,
      input.mediaFileId,
      input.mediaUniqueId,
      input.sentAt,
      input.editedAt,
    );
    const message = this.getMessage(input.chatId, input.messageId);
    if (!message) throw new Error("Failed to store message");
    return message;
  }

  getMessage(chatId: number, messageId: number): StoredMessage | null {
    requireSafeInteger(chatId, "chatId", true);
    requireSafeInteger(messageId, "messageId");
    const row = this.database.prepare(
      "SELECT * FROM mia_messages WHERE chat_id = ? AND message_id = ?",
    ).get(chatId, messageId) as MessageRow | undefined;
    return row ? messageFromRow(row) : null;
  }

  listRecentMessages(scope: ConversationScope, limit = 50): StoredMessage[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError("limit must be between 1 and 500");
    }
    const { chatId, threadId } = conversationCoordinates(scope);
    const rows = this.database.prepare(`
      SELECT * FROM (
        SELECT * FROM mia_messages
        WHERE chat_id = ? AND thread_id = ?
        ORDER BY message_id DESC
        LIMIT ?
      ) ORDER BY message_id ASC
    `).all(chatId, threadId, limit) as MessageRow[];
    return rows.map(messageFromRow);
  }

  getReplyChain(chatId: number, messageId: number, maxDepth = 20): StoredMessage[] {
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 100) {
      throw new RangeError("maxDepth must be between 1 and 100");
    }
    const chain: StoredMessage[] = [];
    const visited = new Set<number>();
    let currentId: number | null = messageId;
    while (currentId !== null && chain.length < maxDepth && !visited.has(currentId)) {
      visited.add(currentId);
      const message = this.getMessage(chatId, currentId);
      if (!message) break;
      chain.push(message);
      currentId = message.replyToMessageId;
    }
    return chain.reverse();
  }

  addSummary(input: SummaryInput): SummaryRecord {
    const scope = normalizeScope(input.scope);
    if (scope.chatId === null) throw new TypeError("Summary requires a conversation scope");
    requireSafeInteger(input.throughMessageId, "throughMessageId");
    if (input.fromMessageId !== null) requireSafeInteger(input.fromMessageId, "fromMessageId");
    const result = this.database.prepare(`
      INSERT INTO mia_summaries (
        scope_type, user_id, chat_id, thread_id, content, from_message_id, through_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      scope.type,
      scope.userId,
      scope.chatId,
      scope.threadId,
      input.content,
      input.fromMessageId,
      input.throughMessageId,
    );
    const row = this.database.prepare("SELECT * FROM mia_summaries WHERE id = ?").get(
      Number(result.lastInsertRowid),
    ) as SummaryRow;
    return summaryFromRow(row);
  }

  getLatestSummary(scope: ConversationScope): SummaryRecord | null {
    const normalized = normalizeScope(scope);
    const row = this.database.prepare(`
      SELECT * FROM mia_summaries
      WHERE scope_type = ? AND user_id IS ? AND chat_id IS ? AND thread_id = ?
      ORDER BY through_message_id DESC, id DESC
      LIMIT 1
    `).get(
      normalized.type,
      normalized.userId,
      normalized.chatId,
      normalized.threadId,
    ) as SummaryRow | undefined;
    return row ? summaryFromRow(row) : null;
  }

  addMemory(input: MemoryInput): MemoryRecord {
    const scope = normalizeScope(input.scope);
    if (input.createdByUserId !== undefined && input.createdByUserId !== null) {
      requireSafeInteger(input.createdByUserId, "createdByUserId");
    }
    if (input.sourceMessageId !== undefined && input.sourceMessageId !== null) {
      requireSafeInteger(input.sourceMessageId, "sourceMessageId");
    }
    const result = this.database.prepare(`
      INSERT INTO mia_memories (
        scope_type, user_id, chat_id, thread_id, category, content,
        source_message_id, created_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scope.type,
      scope.userId,
      scope.chatId,
      scope.threadId,
      input.category,
      input.content,
      input.sourceMessageId ?? null,
      input.createdByUserId ?? null,
    );
    const row = this.database.prepare("SELECT * FROM mia_memories WHERE id = ?").get(
      Number(result.lastInsertRowid),
    ) as MemoryRow;
    return memoryFromRow(row);
  }

  listMemories(scope: MemoryScope, limit = 100): MemoryRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError("limit must be between 1 and 500");
    }
    const normalized = normalizeScope(scope);
    const rows = this.database.prepare(`
      SELECT * FROM mia_memories
      WHERE scope_type = ? AND user_id IS ? AND chat_id IS ? AND thread_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(
      normalized.type,
      normalized.userId,
      normalized.chatId,
      normalized.threadId,
      limit,
    ) as MemoryRow[];
    return rows.map(memoryFromRow);
  }

  clearConversation(scope: ConversationScope): void {
    const normalized = normalizeScope(scope);
    if (normalized.chatId === null) throw new TypeError("Conversation scope requires a chatId");
    this.database.transaction(() => {
      this.database.prepare(
        "DELETE FROM mia_messages WHERE chat_id = ? AND thread_id = ?",
      ).run(normalized.chatId, normalized.threadId);
      this.database.prepare(`
        DELETE FROM mia_summaries
        WHERE scope_type = ? AND chat_id = ? AND thread_id = ?
      `).run(normalized.type, normalized.chatId, normalized.threadId);
      this.database.prepare(`
        DELETE FROM mia_memories
        WHERE scope_type = ? AND chat_id = ? AND thread_id = ?
      `).run(normalized.type, normalized.chatId, normalized.threadId);
    })();
  }

  close(): void {
    this.database.close();
  }
}
