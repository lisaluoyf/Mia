import { afterEach, describe, expect, it, vi } from "vitest";

import { GroupSummaryService } from "../src/context/group-summary.js";
import { createLogger } from "../src/logger.js";
import { GROUP_SUMMARY_SYSTEM_PROMPT, PROMPT_LIBRARY } from "../src/prompts.js";
import { ContextStore } from "../src/storage/store.js";

const completeResult = {
  title: { text: "Bot 玩家群讨论总结", source_message_ids: [2] },
  overview: { text: "大家讨论了 Bot 的隐私模式与总结准确性；password=very-secret-password", source_message_ids: [2, 3] },
  topics: [{ title: "隐私模式", detail: "成员询问隐私模式是否开启。", source_message_ids: [2] }],
  decisions: [
    { text: "使用专用 Prompt 生成群聊总结。", source_message_ids: [3] },
    { text: "伪造结论", source_message_ids: [999] },
  ],
  todos: [{ text: "调整总结 Prompt。", source_message_ids: [4] }],
  open_questions: [{ text: "Bot 是否处于隐身模式仍未确认。", source_message_ids: [2] }],
  participants: [
    { telegram_user_id: 42, name: "Alen", contribution: "提出隐私模式问题。", source_message_ids: [2] },
    { telegram_user_id: 42, name: "错误归因", contribution: "不应出现。", source_message_ids: [3] },
  ],
  historical_context: [
    { text: "群里长期使用 Mia 记录公开结论。", source_message_ids: [1] },
    { text: "不可验证的历史", source_message_ids: [998] },
  ],
  rolling_summary: "群内讨论了隐私模式和总结方案；api key=sk-sensitive-value-123456789",
  memories: [
    { category: "process", content: "Topic 的结论由 Mia 整理", source_message_id: 4 },
    { category: "rule", content: "群级记忆不能写入 Topic", source_message_id: 1 },
    { category: "process", content: "Topic 的结论由 Mia 整理", source_message_id: 4 },
    { category: "rule", content: "token=sk-another-secret-value-1234", source_message_id: 5 },
  ],
};

describe("Mia group summary service", () => {
  let store: ContextStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it("summarizes a 17-message Topic with validated evidence and atomically advances past the reply", async () => {
    store = setupStore(true);
    saveMessage(store, 1, null, 42, "群里长期使用 Mia 记录公开结论");
    store.addMemory({
      scope: { type: "group", chatId: -1001 }, category: "process",
      content: "群里长期使用 Mia 记录公开结论", sourceMessageId: 1, createdByUserId: 42,
    });
    store.addMemory({
      scope: { type: "user", userId: 42 }, category: "preference",
      content: "绝不能进入群聊的私聊记忆", createdByUserId: 42,
    });
    store.addSummary({
      scope: { type: "group", chatId: -1001 }, content: "绝不能进入 Topic 的 General 摘要",
      fromMessageId: 1, throughMessageId: 1,
    });
    for (let id = 2; id <= 18; id += 1) {
      saveMessage(
        store,
        id,
        12,
        id === 3 ? 43 : 42,
        id === 2 ? "你是不是设置隐身了？" : id === 3 ? "我们可以专门写一个总结 Prompt" :
          id === 6 ? "Mira 你能回答吗？" : `Topic 消息 ${id}`,
      );
    }
    store.addMemory({
      scope: { type: "topic", chatId: -1001, threadId: 12 }, category: "process",
      content: "旧的 Topic 流程", sourceMessageId: 2, createdByUserId: 42,
    });
    saveMessage(store, 19, 12, 42, "/summary");
    const structuredChat = vi.fn().mockResolvedValue(completeResult);
    const service = new GroupSummaryService({
      client: { resolveAPIKey: vi.fn(), structuredChat },
      credentials: { resolve: vi.fn().mockResolvedValue({
        apiKey: "guest-key", model: "gpt-5.4", source: "guest", fallbackReason: "telegram_not_bound",
      }) },
      store,
      logger: createLogger("silent"),
      model: "gpt-5.4",
    });

    const prepared = await service.summarize({
      scope: { type: "topic", chatId: -1001, threadId: 12 },
      requesterUserId: 42,
      currentMessageId: 19,
      locale: "zh-CN",
    });

    expect(prepared).not.toBeNull();
    expect(prepared?.messageCount).toBe(17);
    expect(prepared?.truncated).toBe(false);
    expect(prepared?.content.decisions).toEqual([
      { text: "使用专用 Prompt 生成群聊总结。", sourceMessageIds: [3] },
    ]);
    expect(prepared?.content.overview?.text).toBe("大家讨论了 Bot 的隐私模式与总结准确性；[敏感信息已省略]");
    expect(prepared?.content.participants).toEqual([
      { telegramUserId: 42, name: "Alen", contribution: "提出隐私模式问题。", sourceMessageIds: [2] },
    ]);
    expect(prepared?.content.historicalContext).toEqual([
      { text: "群里长期使用 Mia 记录公开结论。", sourceMessageIds: [1] },
    ]);
    const request = JSON.stringify(structuredChat.mock.calls[0]?.[2]);
    expect(request).toContain("[message_id=2");
    expect(request).toContain("[message_id=18");
    expect(request).not.toContain("[message_id=1 ");
    expect(request).not.toContain("[message_id=19 ");
    expect(request).toContain("只读继承");
    expect(request).not.toContain("绝不能进入群聊的私聊记忆");
    expect(request).not.toContain("绝不能进入 Topic 的 General 摘要");
    expect(GROUP_SUMMARY_SYSTEM_PROMPT).toContain("以最简洁的方式总结输入中真实存在的群消息");
    expect(GROUP_SUMMARY_SYSTEM_PROMPT).toContain("区分疑问、提议、结论和待办");
    expect(GROUP_SUMMARY_SYSTEM_PROMPT).toContain("同步返回完整的 rolling_summary 和群公开长期记忆");
    expect(GROUP_SUMMARY_SYSTEM_PROMPT).toContain("所有总结项和记忆必须引用真实 source_message_ids");
    expect(GROUP_SUMMARY_SYSTEM_PROMPT).not.toContain("中文可见正文以 500 字以内为目标");
    expect(GROUP_SUMMARY_SYSTEM_PROMPT).not.toContain("topics 只保留 1 至 5 个最重要进展");

    saveMessage(store, 20, 12, 100, "总结回复");
    expect(service.complete(prepared!, 20, [20])).toBe(true);
    expect(store.getLatestSummary({ type: "topic", chatId: -1001, threadId: 12 })).toMatchObject({
      fromMessageId: 2,
      throughMessageId: 20,
      content: "群内讨论了隐私模式和总结方案；[敏感信息已省略]",
    });
    expect(store.listMemories({ type: "topic", chatId: -1001, threadId: 12 })).toHaveLength(1);
    expect(store.listMemories({ type: "topic", chatId: -1001, threadId: 12 })[0]).toMatchObject({
      category: "process", content: "Topic 的结论由 Mia 整理", sourceMessageId: 4,
    });
    expect(store.listMemories({ type: "group", chatId: -1001 })).toHaveLength(1);
    expect(structuredChat).toHaveBeenCalledTimes(1);
  });

  it("uses the newest 300 messages when backlog is truncated and never advances the watermark", async () => {
    store = setupStore(false);
    for (let id = 1; id <= 301; id += 1) saveMessage(store, id, null, 42, `群消息 ${id}`);
    saveMessage(store, 302, null, 42, "/summary");
    const result = {
      ...completeResult,
      title: { text: "最近讨论", source_message_ids: [2] },
      overview: { text: "最近的群消息。", source_message_ids: [301] },
      topics: [], decisions: [], todos: [], open_questions: [], participants: [], historical_context: [], memories: [],
    };
    const structuredChat = vi.fn().mockResolvedValue(result);
    const debug = { start: vi.fn().mockReturnValue("summary-debug"), finish: vi.fn() };
    const service = new GroupSummaryService({
      client: { resolveAPIKey: vi.fn().mockResolvedValue("user-key"), structuredChat },
      store,
      logger: createLogger("silent"),
      model: "gpt-5.4",
      debug: debug as never,
    });

    const prepared = await service.summarize({
      scope: { type: "group", chatId: -1001 }, requesterUserId: 42, currentMessageId: 302, locale: "zh-CN",
    });

    expect(prepared).toMatchObject({ messageCount: 300, fromMessageId: 2, throughMessageId: 301, truncated: true });
    const request = JSON.stringify(structuredChat.mock.calls[0]?.[2]);
    expect(request).not.toContain("[message_id=1 ");
    expect(request).toContain("[message_id=301 ");
    saveMessage(store, 303, null, 100, "总结回复");
    expect(service.complete(prepared!, 303, [303])).toBe(false);
    expect(store.getLatestSummary({ type: "group", chatId: -1001 })).toBeNull();
    expect(structuredChat).toHaveBeenCalledTimes(1);
    const debugStart: unknown = debug.start.mock.calls[0]?.[0];
    const debugFinish: unknown = debug.finish.mock.calls[0]?.[1];
    expect(debugStart).toMatchObject({
      kind: "group_summary",
      promptRefs: [{ id: "mia.group-summary", version: 4 }, { id: "mia.group-summary-input", version: 1 }],
      details: { selectedMessageCount: 300, truncated: true },
    });
    expect(debug.finish.mock.calls[0]?.[0]).toBe("summary-debug");
    expect(debugFinish).toMatchObject({
      status: "succeeded",
      details: {
        persistenceSkipped: "truncated_backlog",
        rollingSummaryWritten: false,
      },
    });
  });

  it("does not call the model when there is no prior message", async () => {
    store = setupStore(false);
    saveMessage(store, 1, null, 42, "/summary");
    const structuredChat = vi.fn();
    const service = new GroupSummaryService({
      client: { resolveAPIKey: vi.fn(), structuredChat }, store, logger: createLogger("silent"), model: "gpt-5.4",
    });
    await expect(service.summarize({
      scope: { type: "group", chatId: -1001 }, requesterUserId: 42, currentMessageId: 1, locale: "zh-CN",
    })).resolves.toBeNull();
    expect(structuredChat).not.toHaveBeenCalled();
  });

  it("does not advance over a message that arrived while the summary was being generated", async () => {
    store = setupStore(false);
    saveMessage(store, 1, null, 42, "先讨论 A");
    saveMessage(store, 2, null, 42, "/summary");
    const result = {
      ...completeResult,
      title: { text: "讨论 A", source_message_ids: [1] },
      overview: { text: "讨论了 A。", source_message_ids: [1] },
      topics: [], decisions: [], todos: [], open_questions: [], participants: [], historical_context: [], memories: [],
    };
    const service = new GroupSummaryService({
      client: { resolveAPIKey: vi.fn().mockResolvedValue("user-key"), structuredChat: vi.fn().mockResolvedValue(result) },
      store, logger: createLogger("silent"), model: "gpt-5.4",
    });
    const prepared = await service.summarize({
      scope: { type: "group", chatId: -1001 }, requesterUserId: 42, currentMessageId: 2, locale: "zh-CN",
    });
    saveMessage(store, 3, null, 43, "模型调用期间到达的新消息");
    saveMessage(store, 4, null, 100, "总结回复");

    expect(service.complete(prepared!, 4, [4])).toBe(false);
    expect(store.getLatestSummary({ type: "group", chatId: -1001 })).toBeNull();
  });

  it("keeps the previous summary and memories intact when the model fails", async () => {
    store = setupStore(false);
    saveMessage(store, 1, null, 42, "旧结论");
    store.addSummary({
      scope: { type: "group", chatId: -1001 }, content: "旧摘要", fromMessageId: 1, throughMessageId: 1,
    });
    store.addMemory({
      scope: { type: "group", chatId: -1001 }, category: "decision",
      content: "旧结论", sourceMessageId: 1, createdByUserId: 42,
    });
    saveMessage(store, 2, null, 42, "新讨论");
    saveMessage(store, 3, null, 42, "/summary");
    const service = new GroupSummaryService({
      client: {
        resolveAPIKey: vi.fn().mockResolvedValue("user-key"),
        structuredChat: vi.fn().mockRejectedValue(new Error("model failed")),
      },
      store, logger: createLogger("silent"), model: "gpt-5.4",
    });

    await expect(service.summarize({
      scope: { type: "group", chatId: -1001 }, requesterUserId: 42, currentMessageId: 3, locale: "zh-CN",
    })).rejects.toThrow("model failed");
    expect(store.getLatestSummary({ type: "group", chatId: -1001 })?.content).toBe("旧摘要");
    expect(store.listMemories({ type: "group", chatId: -1001 })[0]?.content).toBe("旧结论");
  });

  it("registers the user-visible summary prompts independently from background compaction", () => {
    expect(PROMPT_LIBRARY.find((prompt) => prompt.id === "mia.group-summary")).toMatchObject({ version: 4 });
    expect(PROMPT_LIBRARY.find((prompt) => prompt.id === "mia.group-summary-input")).toMatchObject({ version: 1 });
    expect(PROMPT_LIBRARY.find((prompt) => prompt.id === "mia.group-context-compaction")).toMatchObject({ version: 1 });
  });
});

function setupStore(isForum: boolean): ContextStore {
  const store = new ContextStore(":memory:");
  for (const [id, name, bot] of [[42, "Alen", false], [43, "Roma", false], [100, "Mia", true]] as const) {
    store.upsertUser({
      telegramUserId: id, firstName: name, lastName: null, username: null, languageCode: "zh-CN", isBot: bot,
    });
  }
  store.upsertChat({
    chatId: -1001, type: "supergroup", title: "Bot 玩家", username: null, description: null, isForum,
  });
  return store;
}

function saveMessage(
  store: ContextStore,
  messageId: number,
  threadId: number | null,
  senderUserId: number,
  text: string,
): void {
  store.saveMessage({
    chatId: -1001, messageId, threadId, senderUserId, senderChatId: null,
    replyToMessageId: null, contentType: "text", text, caption: null, entitiesJson: null,
    mediaFileId: null, mediaUniqueId: null, sentAt: "2026-09-03T10:00:00.000Z", editedAt: null,
  });
}
