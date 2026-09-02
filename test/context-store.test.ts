import { afterEach, describe, expect, it } from "vitest";

import { ContextStore } from "../src/storage/store.js";
import type { ChatInput, MessageInput, UserProfileInput } from "../src/storage/types.js";

const user: UserProfileInput = {
  telegramUserId: 42,
  firstName: "Mia",
  lastName: null,
  username: "mia-user",
  languageCode: "zh-CN",
  isBot: false,
};

const privateChat: ChatInput = {
  chatId: 42,
  type: "private",
  title: null,
  username: "mia-user",
  description: null,
  isForum: false,
};

const groupChat: ChatInput = {
  chatId: -1001,
  type: "supergroup",
  title: "Mia builders",
  username: null,
  description: null,
  isForum: true,
};

function message(overrides: Partial<MessageInput> = {}): MessageInput {
  return {
    chatId: privateChat.chatId,
    messageId: 1,
    threadId: null,
    senderUserId: user.telegramUserId,
    senderChatId: null,
    replyToMessageId: null,
    contentType: "text",
    text: "hello",
    caption: null,
    entitiesJson: null,
    mediaFileId: null,
    mediaUniqueId: null,
    sentAt: "2026-09-02T07:00:00.000Z",
    editedAt: null,
    ...overrides,
  };
}

describe("context store", () => {
  let store: ContextStore | undefined;

  afterEach(() => store?.close());

  function createStore(): ContextStore {
    store = new ContextStore(":memory:");
    store.upsertUser(user);
    store.upsertChat(privateChat);
    store.upsertChat(groupChat);
    return store;
  }

  it("maintains global user and per-chat member records", () => {
    const current = createStore();
    current.upsertMember({ chatId: groupChat.chatId, telegramUserId: user.telegramUserId, status: "member" });
    current.upsertUser({ ...user, firstName: "Updated", languageCode: "en" });

    expect(current.getUser(user.telegramUserId)).toMatchObject({
      telegramUserId: 42,
      firstName: "Updated",
      languageCode: "en",
    });
    expect(current.getChat(groupChat.chatId)).toMatchObject({
      chatId: -1001,
      type: "supergroup",
      isForum: true,
    });
  });

  it("uses chat_id with message_id so identical Telegram message ids do not collide", () => {
    const current = createStore();
    current.saveMessage(message());
    current.saveMessage(message({ chatId: groupChat.chatId, text: "group message" }));

    expect(current.getMessage(privateChat.chatId, 1)?.text).toBe("hello");
    expect(current.getMessage(groupChat.chatId, 1)?.text).toBe("group message");
  });

  it("strictly isolates private, group, and topic message contexts", () => {
    const current = createStore();
    current.saveMessage(message());
    current.saveMessage(message({ chatId: groupChat.chatId, messageId: 2, text: "general" }));
    current.saveMessage(message({ chatId: groupChat.chatId, messageId: 3, threadId: 10, text: "topic 10" }));
    current.saveMessage(message({ chatId: groupChat.chatId, messageId: 4, threadId: 20, text: "topic 20" }));

    expect(current.listRecentMessages({ type: "private", chatId: 42 }).map((item) => item.text)).toEqual(["hello"]);
    expect(current.listRecentMessages({ type: "group", chatId: -1001 }).map((item) => item.text)).toEqual(["general"]);
    expect(current.listRecentMessages({ type: "topic", chatId: -1001, threadId: 10 }).map((item) => item.text)).toEqual(["topic 10"]);
    expect(current.listRecentMessages({ type: "topic", chatId: -1001, threadId: 20 }).map((item) => item.text)).toEqual(["topic 20"]);
  });

  it("updates edited messages and follows replies only inside the same chat", () => {
    const current = createStore();
    current.saveMessage(message({ messageId: 1, text: "first" }));
    current.saveMessage(message({ messageId: 2, text: "second", replyToMessageId: 1 }));
    current.saveMessage(message({ messageId: 3, text: "third", replyToMessageId: 2 }));
    current.saveMessage(message({ messageId: 2, text: "second edited", replyToMessageId: 1, editedAt: "2026-09-02T07:05:00.000Z" }));
    current.saveMessage(message({ chatId: groupChat.chatId, messageId: 1, text: "other chat" }));

    expect(current.getReplyChain(privateChat.chatId, 3).map((item) => item.text)).toEqual([
      "first",
      "second edited",
      "third",
    ]);
    expect(current.getMessage(privateChat.chatId, 2)?.editedAt).toBe("2026-09-02T07:05:00.000Z");
  });

  it("isolates global, private, group, and topic memories", () => {
    const current = createStore();
    current.addMemory({ scope: { type: "user", userId: 42 }, category: "preference", content: "Use Chinese" });
    current.addMemory({ scope: { type: "private", chatId: 42 }, category: "secret", content: "Private" });
    current.addMemory({ scope: { type: "group", chatId: -1001 }, category: "rule", content: "No ads" });
    current.addMemory({ scope: { type: "topic", chatId: -1001, threadId: 10 }, category: "decision", content: "Ship Friday" });

    expect(current.listMemories({ type: "user", userId: 42 }).map((item) => item.content)).toEqual(["Use Chinese"]);
    expect(current.listMemories({ type: "private", chatId: 42 }).map((item) => item.content)).toEqual(["Private"]);
    expect(current.listMemories({ type: "group", chatId: -1001 }).map((item) => item.content)).toEqual(["No ads"]);
    expect(current.listMemories({ type: "topic", chatId: -1001, threadId: 10 }).map((item) => item.content)).toEqual(["Ship Friday"]);
  });

  it("stores summaries per conversation and clears only the selected topic", () => {
    const current = createStore();
    current.saveMessage(message({ chatId: groupChat.chatId, messageId: 1, threadId: 10, text: "topic 10" }));
    current.saveMessage(message({ chatId: groupChat.chatId, messageId: 2, threadId: 20, text: "topic 20" }));
    current.addSummary({
      scope: { type: "topic", chatId: groupChat.chatId, threadId: 10 },
      content: "Topic 10 summary",
      fromMessageId: 1,
      throughMessageId: 1,
    });
    current.addMemory({
      scope: { type: "topic", chatId: groupChat.chatId, threadId: 10 },
      category: "decision",
      content: "Topic 10 memory",
    });

    expect(current.getLatestSummary({ type: "topic", chatId: -1001, threadId: 10 })?.content).toBe("Topic 10 summary");
    current.clearConversation({ type: "topic", chatId: -1001, threadId: 10 });

    expect(current.listRecentMessages({ type: "topic", chatId: -1001, threadId: 10 })).toEqual([]);
    expect(current.getLatestSummary({ type: "topic", chatId: -1001, threadId: 10 })).toBeNull();
    expect(current.listMemories({ type: "topic", chatId: -1001, threadId: 10 })).toEqual([]);
    expect(current.listRecentMessages({ type: "topic", chatId: -1001, threadId: 20 })).toHaveLength(1);
  });

  it("tracks completed turns and atomically applies a private compaction", () => {
    const current = createStore();
    current.upsertUser({ ...user, telegramUserId: 99, firstName: "Mia Bot", isBot: true });
    current.saveMessage(message({ messageId: 1, text: "Call me Roma" }));
    current.saveMessage(message({ messageId: 2, senderUserId: 99, replyToMessageId: 1, text: "Sure" }));
    current.addMemory({ scope: { type: "user", userId: 42 }, category: "preference", content: "Old memory" });
    const turn = current.recordCompletedTurn({
      chatId: 42,
      userId: 42,
      userMessageId: 1,
      assistantMessageId: 2,
    });

    expect(current.listPendingCompletedTurns(42)).toHaveLength(1);
    current.applyPrivateCompaction({
      chatId: 42,
      userId: 42,
      turnIds: [turn.id],
      summary: "The user asked to be called Roma.",
      fromMessageId: 1,
      throughMessageId: 2,
      memories: [{ category: "identity", content: "The user prefers to be called Roma" }],
    });

    expect(current.listPendingCompletedTurns(42)).toEqual([]);
    expect(current.getLatestSummary({ type: "private", chatId: 42 })).toMatchObject({
      content: "The user asked to be called Roma.",
      throughMessageId: 2,
    });
    expect(current.listMemories({ type: "user", userId: 42 }).map((item) => item.content)).toEqual([
      "The user prefers to be called Roma",
    ]);
  });
});
