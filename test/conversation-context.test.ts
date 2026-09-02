import { afterEach, describe, expect, it } from "vitest";

import { buildConversationMessages, loadConversationContext } from "../src/context/conversation.js";
import { ContextStore } from "../src/storage/store.js";

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

    expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(serialized).toContain("第 1 轮");
    expect(serialized).toContain("第 2 轮，当前消息");
    expect(serialized).toContain("image_turn_1_1");
    expect(serialized).toContain("status=active");
    expect(serialized).toContain("data:image/jpeg;base64,AQID");
    expect(serialized).toContain("用户希望被称为 Roma");
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
    }], 99))).toContain("status=active");
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
});
