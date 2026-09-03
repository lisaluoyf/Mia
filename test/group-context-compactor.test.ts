import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GROUP_COMPACTION_MESSAGE_THRESHOLD,
  GroupContextCompactor,
} from "../src/context/group-compactor.js";
import { createLogger } from "../src/logger.js";
import { ContextStore } from "../src/storage/store.js";

describe("group context compactor", () => {
  let store: ContextStore | undefined;

  afterEach(() => store?.close());

  it("updates the rolling summary and public memory in one model call at the message threshold", async () => {
    store = new ContextStore(":memory:");
    store.upsertUser({ telegramUserId: 42, firstName: "Roma", lastName: null, username: "roma", languageCode: "zh-CN", isBot: false });
    store.upsertChat({ chatId: -1001, type: "supergroup", title: "Mia builders", username: null, description: null, isForum: false });
    const structuredChat = vi.fn().mockResolvedValue({
      memories: [{ category: "rule", content: "群内禁止广告", source_message_id: 1 }],
      summary: "群成员讨论并确认了禁止广告的规则。",
    });
    const compactor = new GroupContextCompactor({
      client: { resolveAPIKey: vi.fn().mockResolvedValue("payer-key"), structuredChat },
      store,
      logger: createLogger("silent"),
      model: "gpt-5.4",
    });

    for (let messageId = 1; messageId < GROUP_COMPACTION_MESSAGE_THRESHOLD; messageId += 1) {
      saveGroupMessage(store, messageId);
    }
    compactor.recordSuccessfulGroupTrigger({ type: "group", chatId: -1001 }, 42);
    await Promise.resolve();
    expect(structuredChat).not.toHaveBeenCalled();

    saveGroupMessage(store, GROUP_COMPACTION_MESSAGE_THRESHOLD);
    compactor.recordSuccessfulGroupTrigger({ type: "group", chatId: -1001 }, 42);
    await vi.waitFor(() => expect(structuredChat).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(store?.getLatestSummary({ type: "group", chatId: -1001 })?.throughMessageId)
      .toBe(GROUP_COMPACTION_MESSAGE_THRESHOLD));

    expect(store.listMemories({ type: "group", chatId: -1001 })).toMatchObject([{
      category: "rule",
      content: "群内禁止广告",
      sourceMessageId: 1,
      createdByUserId: 42,
    }]);
    const request = JSON.stringify(structuredChat.mock.calls[0]);
    expect(request).toContain("一次完成两项工作");
    expect(request).toContain("message_id=50");

    structuredChat.mockResolvedValueOnce({ memories: [], summary: "更新后的完整群摘要。" });
    for (let messageId = 51; messageId <= 100; messageId += 1) saveGroupMessage(store, messageId);
    compactor.recordSuccessfulGroupTrigger({ type: "group", chatId: -1001 }, 42);
    await vi.waitFor(() => expect(structuredChat).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store?.getLatestSummary({ type: "group", chatId: -1001 })?.throughMessageId).toBe(100));

    expect(JSON.stringify(structuredChat.mock.calls[1])).toContain("群成员讨论并确认了禁止广告的规则");
    expect(JSON.stringify(structuredChat.mock.calls[1])).toContain("群内禁止广告");
    expect(store.listMemories({ type: "group", chatId: -1001 })).toEqual([]);
  });

  it("drops memories with a source outside the current topic", async () => {
    store = new ContextStore(":memory:");
    store.upsertUser({ telegramUserId: 42, firstName: "Roma", lastName: null, username: null, languageCode: null, isBot: false });
    store.upsertChat({ chatId: -1001, type: "supergroup", title: "Mia builders", username: null, description: null, isForum: true });
    saveGroupMessage(store, 1, null);
    for (let messageId = 2; messageId <= GROUP_COMPACTION_MESSAGE_THRESHOLD + 1; messageId += 1) {
      saveGroupMessage(store, messageId, 12);
    }
    const compactor = new GroupContextCompactor({
      client: {
        resolveAPIKey: vi.fn().mockResolvedValue("payer-key"),
        structuredChat: vi.fn().mockResolvedValue({
          memories: [{ category: "rule", content: "Invalid cross-topic source", source_message_id: 1 }],
          summary: "Topic summary; api key=sk-sensitive-value-123456789",
        }),
      },
      store,
      logger: createLogger("silent"),
      model: "gpt-5.4",
    });

    compactor.recordSuccessfulGroupTrigger({ type: "topic", chatId: -1001, threadId: 12 }, 42);
    await vi.waitFor(() => expect(store?.getLatestSummary({ type: "topic", chatId: -1001, threadId: 12 })).not.toBeNull());

    expect(store.listMemories({ type: "topic", chatId: -1001, threadId: 12 })).toEqual([]);
    expect(store.getLatestSummary({ type: "topic", chatId: -1001, threadId: 12 })?.content).toBe(
      "Topic summary; [敏感信息已省略]",
    );
    expect(store.getLatestSummary({ type: "group", chatId: -1001 })).toBeNull();
  });

  it("also triggers when a small number of messages reaches the content budget", async () => {
    store = new ContextStore(":memory:");
    store.upsertUser({ telegramUserId: 42, firstName: "Roma", lastName: null, username: null, languageCode: null, isBot: false });
    store.upsertChat({ chatId: -1001, type: "supergroup", title: "Mia builders", username: null, description: null, isForum: false });
    for (let messageId = 1; messageId <= 3; messageId += 1) {
      saveGroupMessage(store, messageId, null, "群".repeat(4_000));
    }
    const structuredChat = vi.fn().mockResolvedValue({ memories: [], summary: "Large discussion summary" });
    const compactor = new GroupContextCompactor({
      client: { resolveAPIKey: vi.fn().mockResolvedValue("payer-key"), structuredChat },
      store,
      logger: createLogger("silent"),
      model: "gpt-5.4",
    });

    compactor.recordSuccessfulGroupTrigger({ type: "group", chatId: -1001 }, 42);
    await vi.waitFor(() => expect(structuredChat).toHaveBeenCalledTimes(1));

    expect(store.getLatestSummary({ type: "group", chatId: -1001 })?.throughMessageId).toBe(3);
  });
});

function saveGroupMessage(
  store: ContextStore,
  messageId: number,
  threadId: number | null = null,
  text = messageId === 1 ? "群内禁止广告" : `群消息 ${messageId}`,
): void {
  store.saveMessage({
    chatId: -1001, messageId, threadId, senderUserId: 42, senderChatId: null,
    replyToMessageId: null, contentType: "text", text,
    caption: null, entitiesJson: null, mediaFileId: null, mediaUniqueId: null,
    sentAt: "2026-09-03T10:00:00.000Z", editedAt: null,
  });
}
