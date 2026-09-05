import { afterEach, describe, expect, it } from "vitest";

import { ContextStore } from "../src/storage/store.js";

describe("translation mode store", () => {
  let store: ContextStore | undefined;

  afterEach(() => store?.close());

  it("keeps a private session active for thirty minutes and expires it afterwards", () => {
    store = new ContextStore(":memory:");
    store.upsertUser({ telegramUserId: 42, firstName: "Liz", lastName: null, username: null, languageCode: "zh-CN", isBot: false });
    store.upsertChat({ chatId: 42, type: "private", title: null, username: null, description: null, isForum: false });
    const started = new Date("2026-09-05T10:00:00.000Z");
    store.enterTranslationSession(42, 42, "zh-CN", "en", started);
    expect(store.getActiveTranslationSession(42, 42, new Date("2026-09-05T10:29:59.999Z"))).not.toBeNull();
    expect(store.getActiveTranslationSession(42, 42, new Date("2026-09-05T10:30:00.000Z"))).toBeNull();
  });

  it("updates the pair and activity timestamp", () => {
    store = new ContextStore(":memory:");
    store.upsertUser({ telegramUserId: 42, firstName: "Liz", lastName: null, username: null, languageCode: "zh-CN", isBot: false });
    store.upsertChat({ chatId: 42, type: "private", title: null, username: null, description: null, isForum: false });
    store.enterTranslationSession(42, 42, "zh-CN", "en", new Date("2026-09-05T10:00:00.000Z"));
    store.setTranslationLanguagePair(42, 42, "zh-CN", "ru");
    store.touchTranslationSession(42, 42, new Date("2026-09-05T10:10:00.000Z"));
    expect(store.getActiveTranslationSession(42, 42, new Date("2026-09-05T10:39:59.999Z"))).toMatchObject({
      userLanguage: "zh-CN",
      foreignLanguage: "ru",
      lastActivityAt: "2026-09-05T10:10:00.000Z",
    });
  });

  it("keeps translation messages out of normal context queries", () => {
    store = new ContextStore(":memory:");
    store.upsertUser({ telegramUserId: 42, firstName: "Liz", lastName: null, username: null, languageCode: "zh-CN", isBot: false });
    store.upsertChat({ chatId: 42, type: "private", title: null, username: null, description: null, isForum: false });
    store.saveMessage({
      chatId: 42, messageId: 1, threadId: null, senderUserId: 42, senderChatId: null, replyToMessageId: null,
      contentType: "text", text: "我正在做一个长期项目", caption: null, entitiesJson: null,
      mediaFileId: null, mediaUniqueId: null, sentAt: "2026-09-05T10:00:00.000Z", editedAt: null,
    });
    store.saveMessage({
      chatId: 42, messageId: 2, threadId: null, senderUserId: 42, senderChatId: null, replyToMessageId: null,
      contentType: "text", text: "I am translating someone else's message", caption: null, entitiesJson: null,
      mediaFileId: null, mediaUniqueId: null, sentAt: "2026-09-05T10:01:00.000Z", editedAt: null,
    });
    store.markMessageAsTranslation(42, 2);
    expect(store.listRecentMessages({ type: "private", chatId: 42 }).map((message) => message.messageId)).toEqual([1]);
    expect(store.listMessagesBetween({ type: "private", chatId: 42 }, 1, 2).map((message) => message.messageId)).toEqual([1]);
  });
});
