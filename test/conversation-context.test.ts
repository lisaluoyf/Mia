import { afterEach, describe, expect, it } from "vitest";

import {
  buildConversationMessages,
  estimateStoredMessageTokens,
  GROUP_CONTEXT_TOKEN_BUDGET,
  loadConversationContext,
} from "../src/context/conversation.js";
import { ContextStore } from "../src/storage/store.js";

interface MessageIndex {
  message_index: Array<Record<string, unknown>>;
  message_index_note: string;
}

function readMessageIndex(messages: ReturnType<typeof buildConversationMessages>): MessageIndex {
  const entry = messages[1];
  if (entry === undefined) throw new Error("message index system message is missing");
  return JSON.parse(String(entry.content)) as MessageIndex;
}

describe("conversation context", () => {
  let store: ContextStore | undefined;

  afterEach(() => store?.close());

  it("orders turns and binds actual images to their source turn and status", () => {
    store = new ContextStore(":memory:");
    store.upsertUser({ telegramUserId: 42, firstName: "Roma", lastName: null, username: "roma", languageCode: "zh-CN", isBot: false });
    store.upsertUser({ telegramUserId: 99, firstName: "Mia", lastName: null, username: "mia", languageCode: null, isBot: true });
    store.upsertChat({ chatId: 42, type: "private", title: null, username: "roma", description: null, isForum: false });
    store.addMemory({ scope: { type: "user", userId: 42 }, category: "identity", content: "用户希望被称为 Roma" });
    store.saveMessage({
      chatId: 42, messageId: 1, threadId: null, senderUserId: 42, senderChatId: null,
      replyToMessageId: null, contentType: "photo", text: null, caption: "看一下这张图",
      entitiesJson: null, mediaFileId: "old-file", mediaUniqueId: "old-unique",
      sentAt: "2026-09-02T10:00:00.000Z", editedAt: null,
    });
    store.saveMessage({
      chatId: 42, messageId: 2, threadId: null, senderUserId: 99, senderChatId: null,
      replyToMessageId: 1, contentType: "text", text: "看到了", caption: null,
      entitiesJson: null, mediaFileId: null, mediaUniqueId: null,
      sentAt: "2026-09-02T10:00:01.000Z", editedAt: null,
    });
    store.saveMessage({
      chatId: 42, messageId: 3, threadId: null, senderUserId: 42, senderChatId: null,
      replyToMessageId: null, contentType: "text", text: "里面的人在做什么？", caption: null,
      entitiesJson: null, mediaFileId: null, mediaUniqueId: null,
      sentAt: "2026-09-02T10:00:02.000Z", editedAt: null,
    });

    const context = loadConversationContext({
      store,
      scope: { type: "private", chatId: 42 },
      userId: 42,
      currentMessageId: 3,
      replyToMessageId: null,
      activeMedia: {
        position: 0, messageId: 1, fileId: "old-file", fileUniqueId: "old-unique",
        type: "photo", mimeType: "image/jpeg", mediaGroupId: null,
      },
      metadata: {
        chatType: "private", chatTitle: null, currentUser: "Roma", language: "zh-CN",
        currentTime: "2026-09-02T10:00:02.000Z", timezone: null, trigger: "message", currentTask: null,
      },
    }, 99);
    const messages = buildConversationMessages(context, [{
      bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg", filename: "old.jpg",
    }], 99);
    const serialized = JSON.stringify(messages);

    expect(messages.map((message) => message.role)).toEqual(["system", "system", "user", "assistant", "user"]);
    const index = readMessageIndex(messages);
    expect(index.message_index).toEqual([
      {
        message_id: 1, turn: 1, role: "user", sender_user_id: 42, sender_name: "Roma",
        image_id: "image_turn_1_1", image_status: "active", image_pixels: "provided",
      },
      { message_id: 2, turn: 1, role: "assistant", sender_user_id: 99, sender_name: "Mia", reply_to_message_id: 1 },
      { message_id: 3, turn: 2, role: "user", current: true, sender_user_id: 42, sender_name: "Roma" },
    ]);
    expect(serialized).toContain("image_turn_1_1");
    expect(serialized).toContain("data:image/jpeg;base64,AQID");
    expect(serialized).toContain("用户希望被称为 Roma");
    // Message bodies stay clean: internal index markers never appear in user-visible text.
    expect(messages[2]?.content).toEqual([
      { type: "text", text: "看一下这张图" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AQID" } },
    ]);
    expect(messages[4]?.content).toBe("里面的人在做什么？");
    expect(messages.filter((message) => message.role !== "system")
      .some((message) => /message_id=|第 \d+ 轮|sender_user_id=/.test(String(message.content)))).toBe(false);
  });

  it("keeps an active image available after its original turn was summarized", () => {
    store = new ContextStore(":memory:");
    store.upsertUser({ telegramUserId: 42, firstName: "Roma", lastName: null, username: null, languageCode: "zh-CN", isBot: false });
    store.upsertUser({ telegramUserId: 99, firstName: "Mia", lastName: null, username: "mia", languageCode: null, isBot: true });
    store.upsertChat({ chatId: 42, type: "private", title: null, username: null, description: null, isForum: false });
    store.saveMessage({
      chatId: 42, messageId: 1, threadId: null, senderUserId: 42, senderChatId: null,
      replyToMessageId: null, contentType: "photo", text: null, caption: "这张产品图",
      entitiesJson: null, mediaFileId: "active-file", mediaUniqueId: "active-unique",
      sentAt: "2026-09-02T10:00:00.000Z", editedAt: null,
    });
    store.saveMessage({
      chatId: 42, messageId: 2, threadId: null, senderUserId: 99, senderChatId: null,
      replyToMessageId: 1, contentType: "text", text: "收到", caption: null,
      entitiesJson: null, mediaFileId: null, mediaUniqueId: null,
      sentAt: "2026-09-02T10:00:01.000Z", editedAt: null,
    });
    store.addSummary({
      scope: { type: "private", chatId: 42 }, content: "用户正在讨论一张产品图。",
      fromMessageId: 1, throughMessageId: 2,
    });
    store.saveMessage({
      chatId: 42, messageId: 3, threadId: null, senderUserId: 42, senderChatId: null,
      replyToMessageId: null, contentType: "text", text: "把背景再亮一点", caption: null,
      entitiesJson: null, mediaFileId: null, mediaUniqueId: null,
      sentAt: "2026-09-02T10:00:02.000Z", editedAt: null,
    });

    const context = loadConversationContext({
      store,
      scope: { type: "private", chatId: 42 },
      userId: 42,
      currentMessageId: 3,
      replyToMessageId: null,
      activeMedia: {
        position: 0, messageId: 1, fileId: "active-file", fileUniqueId: "active-unique",
        type: "photo", mimeType: "image/jpeg", mediaGroupId: null,
      },
      metadata: {
        chatType: "private", chatTitle: null, currentUser: "Roma", language: "zh-CN",
        currentTime: "2026-09-02T10:00:02.000Z", timezone: null, trigger: "message", currentTask: null,
      },
    }, 99);

    expect(context.messages.map((message) => message.messageId)).toEqual([1, 3]);
    expect(context.mediaInputs).toMatchObject([{ messageId: 1, fileId: "active-file" }]);
    expect(JSON.stringify(buildConversationMessages(context, [{
      bytes: new Uint8Array([4, 5, 6]), mimeType: "image/jpeg", filename: "active.jpg",
    }], 99)));
    expect(readMessageIndex(buildConversationMessages(context, [], 99)).message_index)
      .toContainEqual(expect.objectContaining({ message_id: 1, image_status: "active", image_pixels: "not_provided" }));
  });

  it("keeps the newest historical images when the context exceeds the image limit", () => {
    store = new ContextStore(":memory:");
    store.upsertUser({ telegramUserId: 42, firstName: "Roma", lastName: null, username: null, languageCode: "zh-CN", isBot: false });
    store.upsertUser({ telegramUserId: 99, firstName: "Mia", lastName: null, username: "mia", languageCode: null, isBot: true });
    store.upsertChat({ chatId: 42, type: "private", title: null, username: null, description: null, isForum: false });
    for (let messageId = 1; messageId <= 12; messageId += 1) {
      store.saveMessage({
        chatId: 42, messageId, threadId: null, senderUserId: 42, senderChatId: null,
        replyToMessageId: null, contentType: "photo", text: null, caption: `图片 ${messageId}`,
        entitiesJson: null, mediaFileId: `file-${messageId}`, mediaUniqueId: `unique-${messageId}`,
        sentAt: "2026-09-02T10:00:00.000Z", editedAt: null,
      });
    }

    const context = loadConversationContext({
      store,
      scope: { type: "private", chatId: 42 },
      userId: 42,
      currentMessageId: 12,
      replyToMessageId: null,
      metadata: {
        chatType: "private", chatTitle: null, currentUser: "Roma", language: "zh-CN",
        currentTime: "2026-09-02T10:00:02.000Z", timezone: null, trigger: "message", currentTask: null,
      },
    }, 99);

    expect(context.mediaInputs.map((media) => media.messageId)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });

  it("prioritizes the triggering member's public topic messages and never injects private memory", () => {
    store = new ContextStore(":memory:");
    store.upsertUser({ telegramUserId: 42, firstName: "Roma", lastName: null, username: "roma", languageCode: "zh-CN", isBot: false });
    store.upsertUser({ telegramUserId: 43, firstName: "Lee", lastName: null, username: "lee", languageCode: "zh-CN", isBot: false });
    store.upsertUser({ telegramUserId: 99, firstName: "Mia", lastName: null, username: "mia", languageCode: null, isBot: true });
    store.upsertChat({ chatId: -1001, type: "supergroup", title: "Builders", username: null, description: null, isForum: true });
    store.addMemory({ scope: { type: "user", userId: 42 }, category: "preference", content: "PRIVATE SECRET" });
    store.addMemory({ scope: { type: "group", chatId: -1001 }, category: "rule", content: "No ads" });
    store.addMemory({ scope: { type: "topic", chatId: -1001, threadId: 12 }, category: "project", content: "Launch project" });
    for (let messageId = 1; messageId <= 60; messageId += 1) {
      const senderUserId = messageId <= 2 ? 42 : 43;
      store.saveMessage({
        chatId: -1001, messageId, threadId: 12, senderUserId, senderChatId: null,
        replyToMessageId: null, contentType: "text",
        text: messageId === 1 ? "Use the red design" : `Topic message ${messageId}`,
        caption: null, entitiesJson: null, mediaFileId: null, mediaUniqueId: null,
        sentAt: `2026-09-03T10:${String(messageId % 60).padStart(2, "0")}:00.000Z`, editedAt: null,
      });
    }
    store.addSummary({
      scope: { type: "topic", chatId: -1001, threadId: 12 },
      content: "Earlier topic discussion", fromMessageId: 1, throughMessageId: 40,
    });
    store.saveMessage({
      chatId: -1001, messageId: 61, threadId: 12, senderUserId: 42, senderChatId: null,
      replyToMessageId: null, contentType: "text", text: "@Mia follow what I said",
      caption: null, entitiesJson: null, mediaFileId: null, mediaUniqueId: null,
      sentAt: "2026-09-03T11:01:00.000Z", editedAt: null,
    });

    const context = loadConversationContext({
      store,
      scope: { type: "topic", chatId: -1001, threadId: 12 },
      userId: 42,
      currentMessageId: 61,
      replyToMessageId: null,
      metadata: {
        chatType: "supergroup", chatTitle: "Builders", currentUser: "roma", language: "zh-CN",
        currentTime: "2026-09-03T11:01:00.000Z", timezone: null, trigger: "message", currentTask: null,
      },
    }, 99);
    const built = buildConversationMessages(context, [], 99);
    const serialized = JSON.stringify(built);

    expect(context.messages.map((item) => item.messageId)).toContain(1);
    expect(context.messages.at(-1)?.messageId).toBe(61);
    expect(context.memories.map((item) => item.content)).toEqual(["No ads", "Launch project"]);
    expect(serialized).toContain("Use the red design");
    expect(readMessageIndex(built).message_index)
      .toContainEqual(expect.objectContaining({ message_id: 61, sender_name: "Roma" }));
    expect(serialized).not.toContain("PRIVATE SECRET");
  });

  it("uses 100 Topic messages plus the triggering member's recent messages and prioritizes valid nearby media", () => {
    store = new ContextStore(":memory:");
    store.upsertUser({ telegramUserId: 42, firstName: "Roma", lastName: null, username: "roma", languageCode: "zh-CN", isBot: false });
    store.upsertUser({ telegramUserId: 43, firstName: "Lee", lastName: null, username: "lee", languageCode: "zh-CN", isBot: false });
    store.upsertUser({ telegramUserId: 99, firstName: "Mia", lastName: null, username: "mia", languageCode: null, isBot: true });
    store.upsertChat({ chatId: -1001, type: "supergroup", title: "Builders", username: null, description: null, isForum: true });
    for (let messageId = 1; messageId <= 39; messageId += 1) {
      const own = messageId <= 8;
      const photo = [2, 10, 21].includes(messageId);
      const minute = messageId === 2 ? 41 : messageId === 21 ? 55 : 0;
      store.saveMessage({
        chatId: -1001, messageId, threadId: 12, senderUserId: own ? 42 : 43, senderChatId: null,
        replyToMessageId: null, contentType: photo ? "photo" : "text", text: photo ? null : `Message ${messageId}`,
        caption: photo ? `Photo ${messageId}` : null, entitiesJson: null,
        mediaFileId: photo ? `file-${messageId}` : null, mediaUniqueId: photo ? `unique-${messageId}` : null,
        sentAt: `2026-09-03T${messageId === 10 ? "10:00" : `11:${String(minute || messageId % 60).padStart(2, "0")}`}:00.000Z`, editedAt: null,
      });
    }
    store.saveMessage({
      chatId: -1001, messageId: 40, threadId: 12, senderUserId: 42, senderChatId: null,
      replyToMessageId: 10, contentType: "text", text: "@Mia use that image", caption: null,
      entitiesJson: null, mediaFileId: null, mediaUniqueId: null,
      sentAt: "2026-09-03T12:10:00.000Z", editedAt: null,
    });

    const context = loadConversationContext({
      store,
      scope: { type: "topic", chatId: -1001, threadId: 12 },
      userId: 42,
      currentMessageId: 40,
      replyToMessageId: 10,
      metadata: {
        chatType: "supergroup", chatTitle: "Builders", currentUser: "roma", language: "zh-CN",
        currentTime: "2026-09-03T12:10:00.000Z", timezone: null, trigger: "reply", currentTask: null,
      },
    }, 99);

    const ids = context.messages.map((message) => message.messageId);
    expect(ids).toContain(2);
    expect(ids).toContain(1);
    expect(ids).toContain(20);
    expect(ids).toContain(21);
    expect(ids).toContain(40);
    expect(context.mediaInputs.map((media) => media.messageId)).toEqual([10, 2, 21]);
    expect(readMessageIndex(buildConversationMessages(context, [], 99)).message_index)
      .toContainEqual(expect.objectContaining({ message_id: 10, image_status: "replied", image_pixels: "not_provided" }));
  });

  it("keeps the triggering member's eight latest messages even when they predate the group tail", () => {
    store = new ContextStore(":memory:");
    store.upsertUser({ telegramUserId: 42, firstName: "Roma", lastName: null, username: "roma", languageCode: "zh-CN", isBot: false });
    store.upsertUser({ telegramUserId: 43, firstName: "Lee", lastName: null, username: "lee", languageCode: "zh-CN", isBot: false });
    store.upsertUser({ telegramUserId: 99, firstName: "Mia", lastName: null, username: "mia", languageCode: null, isBot: true });
    store.upsertChat({ chatId: -1001, type: "supergroup", title: "Builders", username: null, description: null, isForum: false });
    for (let messageId = 1; messageId <= 150; messageId += 1) {
      const senderUserId = messageId <= 8 || messageId === 150 ? 42 : 43;
      store.saveMessage({
        chatId: -1001, messageId, threadId: null, senderUserId, senderChatId: null,
        replyToMessageId: null, contentType: "text", text: `Message ${messageId}`,
        caption: null, entitiesJson: null, mediaFileId: null, mediaUniqueId: null,
        sentAt: `2026-09-03T10:${String(messageId % 60).padStart(2, "0")}:00.000Z`, editedAt: null,
      });
    }

    const context = loadConversationContext({
      store,
      scope: { type: "group", chatId: -1001 },
      userId: 42,
      currentMessageId: 150,
      replyToMessageId: null,
      metadata: {
        chatType: "supergroup", chatTitle: "Builders", currentUser: "roma", language: "zh-CN",
        currentTime: "2026-09-03T11:00:00.000Z", timezone: null, trigger: "message", currentTask: null,
      },
    }, 99);

    const ids = context.messages.map((message) => message.messageId);
    expect(ids).toEqual(expect.arrayContaining([2, 3, 4, 5, 6, 7, 8, 51, 150]));
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(50);
  });

  it("keeps the current message, reply chain, and triggering member ahead of the group tail within the token budget", () => {
    store = new ContextStore(":memory:");
    store.upsertUser({ telegramUserId: 42, firstName: "Roma", lastName: null, username: "roma", languageCode: "zh-CN", isBot: false });
    store.upsertUser({ telegramUserId: 43, firstName: "Lee", lastName: null, username: "lee", languageCode: "zh-CN", isBot: false });
    store.upsertUser({ telegramUserId: 99, firstName: "Mia", lastName: null, username: "mia", languageCode: null, isBot: true });
    store.upsertChat({ chatId: -1001, type: "supergroup", title: "Builders", username: null, description: null, isForum: false });
    const body = "中".repeat(1_100);
    for (let messageId = 1; messageId <= 150; messageId += 1) {
      const senderUserId = messageId <= 8 || messageId === 150 ? 42 : 43;
      store.saveMessage({
        chatId: -1001, messageId, threadId: null, senderUserId, senderChatId: null,
        replyToMessageId: messageId === 9 ? 8 : messageId === 150 ? 9 : null,
        contentType: "text", text: `Message ${messageId} ${body}`,
        caption: null, entitiesJson: null, mediaFileId: null, mediaUniqueId: null,
        sentAt: `2026-09-03T10:${String(messageId % 60).padStart(2, "0")}:00.000Z`, editedAt: null,
      });
    }

    const context = loadConversationContext({
      store,
      scope: { type: "group", chatId: -1001 },
      userId: 42,
      currentMessageId: 150,
      replyToMessageId: 9,
      metadata: {
        chatType: "supergroup", chatTitle: "Builders", currentUser: "roma", language: "zh-CN",
        currentTime: "2026-09-03T11:00:00.000Z", timezone: null, trigger: "reply", currentTask: null,
      },
    }, 99);

    const ids = context.messages.map((message) => message.messageId);
    expect(ids).toEqual(expect.arrayContaining([2, 3, 4, 5, 6, 7, 8, 9, 149, 150]));
    expect(context.messages.reduce((total, message) => total + estimateStoredMessageTokens(message), 0))
      .toBeLessThanOrEqual(GROUP_CONTEXT_TOKEN_BUDGET);
  });
});
