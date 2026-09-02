export type TelegramChatType = "private" | "group" | "supergroup" | "channel";

export interface UserProfileInput {
  telegramUserId: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
  languageCode: string | null;
  isBot: boolean;
}

export interface UserProfile extends UserProfileInput {
  createdAt: string;
  updatedAt: string;
}

export interface ChatInput {
  chatId: number;
  type: TelegramChatType;
  title: string | null;
  username: string | null;
  description: string | null;
  isForum: boolean;
}

export interface ChatRecord extends ChatInput {
  createdAt: string;
  updatedAt: string;
}

export interface ChatMemberInput {
  chatId: number;
  telegramUserId: number;
  status: string | null;
}

export interface MessageInput {
  chatId: number;
  messageId: number;
  threadId: number | null;
  senderUserId: number | null;
  senderChatId: number | null;
  replyToMessageId: number | null;
  contentType: string;
  text: string | null;
  caption: string | null;
  entitiesJson: string | null;
  mediaFileId: string | null;
  mediaUniqueId: string | null;
  sentAt: string;
  editedAt: string | null;
}

export interface StoredMessage extends MessageInput {
  createdAt: string;
  updatedAt: string;
}

export type MemoryScope =
  | { type: "user"; userId: number }
  | { type: "private"; chatId: number }
  | { type: "group"; chatId: number }
  | { type: "topic"; chatId: number; threadId: number };

export type ConversationScope = Exclude<MemoryScope, { type: "user" }>;

export interface MemoryInput {
  scope: MemoryScope;
  category: string;
  content: string;
  sourceMessageId?: number | null;
  createdByUserId?: number | null;
}

export interface MemoryRecord {
  id: number;
  scope: MemoryScope;
  category: string;
  content: string;
  sourceMessageId: number | null;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SummaryInput {
  scope: ConversationScope;
  content: string;
  fromMessageId: number | null;
  throughMessageId: number;
}

export interface SummaryRecord extends SummaryInput {
  id: number;
  createdAt: string;
}
