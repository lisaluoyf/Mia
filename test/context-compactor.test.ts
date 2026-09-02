import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextCompactor } from "../src/context/compactor.js";
import { createLogger } from "../src/logger.js";
import { ContextStore } from "../src/storage/store.js";

describe("context compactor", () => {
  let store: ContextStore | undefined;

  afterEach(() => store?.close());

  it("runs after ten successful private turns and replaces the complete memory list", async () => {
    store = new ContextStore(":memory:");
    store.upsertUser({ telegramUserId: 42, firstName: "Roma", lastName: null, username: "roma", languageCode: "zh-CN", isBot: false });
    store.upsertUser({ telegramUserId: 99, firstName: "Mia", lastName: null, username: "mia", languageCode: null, isBot: true });
    store.upsertChat({ chatId: 42, type: "private", title: null, username: "roma", description: null, isForum: false });
    store.addMemory({ scope: { type: "user", userId: 42 }, category: "preference", content: "旧记忆" });
    const structuredChat = vi.fn().mockResolvedValue({
      memories: [{ category: "identity", content: "用户希望被称为 Roma" }],
      summary: "用户正在讨论 Mia 的上下文设计。",
    });
    const compactor = new ContextCompactor({
      client: { resolveAPIKey: vi.fn().mockResolvedValue("user-key"), structuredChat },
      store,
      logger: createLogger("silent"),
      model: "gpt-5.4",
    });

    for (let turn = 1; turn <= 9; turn += 1) {
      const userMessageId = turn * 2 - 1;
      const assistantMessageId = turn * 2;
      saveTurn(store, userMessageId, assistantMessageId);
      compactor.recordSuccessfulPrivateTurn({ chatId: 42, userId: 42, userMessageId, assistantMessageId });
    }
    await Promise.resolve();
    expect(structuredChat).not.toHaveBeenCalled();

    saveTurn(store, 19, 20);
    compactor.recordSuccessfulPrivateTurn({ chatId: 42, userId: 42, userMessageId: 19, assistantMessageId: 20 });
    await vi.waitFor(() => expect(structuredChat).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(store?.listPendingCompletedTurns(42)).toEqual([]));

    expect(store.listMemories({ type: "user", userId: 42 }).map((memory) => memory.content)).toEqual([
      "用户希望被称为 Roma",
    ]);
    expect(store.getLatestSummary({ type: "private", chatId: 42 })).toMatchObject({
      content: "用户正在讨论 Mia 的上下文设计。",
      fromMessageId: 1,
      throughMessageId: 20,
    });
    const request = JSON.stringify(structuredChat.mock.calls[0]);
    expect(request).toContain("旧记忆");
    expect(request).toContain("最近 10 轮对话");

    for (let turn = 11; turn <= 20; turn += 1) {
      const userMessageId = turn * 2 - 1;
      const assistantMessageId = turn * 2;
      saveTurn(store, userMessageId, assistantMessageId);
      compactor.recordSuccessfulPrivateTurn({ chatId: 42, userId: 42, userMessageId, assistantMessageId });
    }
    await vi.waitFor(() => expect(structuredChat).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store?.getLatestSummary({ type: "private", chatId: 42 })?.throughMessageId).toBe(40));
  });
});

function saveTurn(store: ContextStore, userMessageId: number, assistantMessageId: number): void {
  store.saveMessage({
    chatId: 42, messageId: userMessageId, threadId: null, senderUserId: 42, senderChatId: null,
    replyToMessageId: null, contentType: "text", text: `用户消息 ${userMessageId}`, caption: null,
    entitiesJson: null, mediaFileId: null, mediaUniqueId: null,
    sentAt: "2026-09-02T10:00:00.000Z", editedAt: null,
  });
  store.saveMessage({
    chatId: 42, messageId: assistantMessageId, threadId: null, senderUserId: 99, senderChatId: null,
    replyToMessageId: userMessageId, contentType: "text", text: `Mia 回复 ${assistantMessageId}`, caption: null,
    entitiesJson: null, mediaFileId: null, mediaUniqueId: null,
    sentAt: "2026-09-02T10:00:01.000Z", editedAt: null,
  });
}
