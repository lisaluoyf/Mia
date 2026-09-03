import { afterEach, describe, expect, it, vi } from "vitest";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import type { IntentRouter, RoutedIntent } from "../src/intent/router.js";
import { createLogger } from "../src/logger.js";
import { MediaStore } from "../src/media/store.js";
import { OnboardingService } from "../src/onboarding/service.js";
import { ContextStore } from "../src/storage/store.js";
import { createBot } from "../src/telegram/bot.js";

const botInfo = {
  id: 100, is_bot: true, first_name: "Mia", username: "apimasterai_bot",
  can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
};

function routed(overrides: Partial<RoutedIntent> = {}): RoutedIntent {
  return {
    intent: "chat", confidence: 0.99, instruction: "", media_source: "none",
    image_options: null, video_options: null, final_response: "你好，很高兴认识你。",
    conversation_mode: "casual", onboarding_opportunity: true, profile_updates: null,
    missingRequired: [], ...overrides,
  };
}

describe("Telegram private onboarding", () => {
  let contexts: ContextStore | undefined;
  let mediaStore: MediaStore | undefined;
  afterEach(() => { contexts?.close(); mediaStore?.close(); contexts = undefined; mediaStore = undefined; });

  function setup(result: RoutedIntent) {
    contexts = new ContextStore(":memory:");
    mediaStore = new MediaStore(":memory:");
    const classify = vi.fn().mockResolvedValue(result);
    const bot = createBot("123:test", {
      client: { resolveAPIKey: vi.fn().mockResolvedValue("key") } as unknown as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn().mockReturnValue({ chatModel: "grok-4.5", imageModel: "gpt-image-2", videoModel: "minimax-h3" }) },
      contexts,
      compactor: { recordSuccessfulPrivateTurn: (input: Parameters<ContextStore["recordCompletedTurn"]>[0]) => contexts?.recordCompletedTurn(input) } as never,
      onboarding: new OnboardingService(contexts),
      mediaStore,
      router: { model: "gpt-5.4", classify } as unknown as IntentRouter,
      botToken: "123:test",
    });
    bot.botInfo = botInfo;
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    let messageId = 100;
    bot.api.config.use((_previous, method, payload) => {
      calls.push({ method, payload });
      if (method === "sendMessage") {
        messageId += 1;
        return Promise.resolve({ ok: true, result: {
          message_id: messageId, date: 1_788_333_700,
          chat: { id: Number(payload.chat_id), type: Number(payload.chat_id) > 0 ? "private" : "supergroup", first_name: "Lisa", title: "Group" },
          from: botInfo, text: String(payload.text ?? ""),
        } } as never);
      }
      return Promise.resolve({ ok: true, result: true } as never);
    });
    return { bot, calls, classify };
  }

  it("answers normally, asks once, saves a role immediately, and keeps duplicate callbacks idempotent", async () => {
    const { bot, calls, classify } = setup(routed());
    await bot.handleUpdate({ update_id: 1, message: {
      message_id: 1, date: 1_788_333_600, chat: { id: 42, type: "private", first_name: "Lisa" },
      from: { id: 42, is_bot: false, first_name: "Lisa", language_code: "zh-CN" }, text: "嗨，今天挺开心的",
    } } as never);

    const sent = calls.filter((call) => call.method === "sendMessage");
    expect(sent.map((call) => call.payload.text)).toEqual([
      "你好，很高兴认识你。",
      "对了，想更好地认识一下你。你平时主要属于哪一类？",
    ]);
    const replyMarkup = sent[1]?.payload.reply_markup as { inline_keyboard?: unknown } | undefined;
    expect(Array.isArray(replyMarkup?.inline_keyboard)).toBe(true);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(contexts?.getOnboardingState(42)).toMatchObject({ promptCount: 1, stage: "awaiting_role" });

    const callbackMessage = {
      message_id: 102, date: 1_788_333_700, chat: { id: 42, type: "private", first_name: "Lisa" },
      from: botInfo, text: "对了，想更好地认识一下你。你平时主要属于哪一类？",
    };
    await bot.handleUpdate({ update_id: 2, callback_query: {
      id: "onboard-1", from: { id: 42, is_bot: false, first_name: "Lisa", language_code: "zh-CN" },
      chat_instance: "x", data: "onboard:role:developer", message: callbackMessage,
    } } as never);
    await bot.handleUpdate({ update_id: 3, callback_query: {
      id: "onboard-duplicate", from: { id: 42, is_bot: false, first_name: "Lisa", language_code: "zh-CN" },
      chat_instance: "x", data: "onboard:role:developer", message: callbackMessage,
    } } as never);

    expect(contexts?.listMemories({ type: "user", userId: 42 }).filter((item) => item.content === "Primary role: Developer")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "sendMessage" && String(call.payload.text).includes("怎么称呼你"))).toHaveLength(1);
  });

  it("never reads or updates onboarding in a group topic even if the model asks to trigger it", async () => {
    const { bot, calls } = setup(routed({ profile_updates: { preferred_name: "Roma", primary_role: "developer", primary_goal: "build Mia" } }));
    await bot.handleUpdate({ update_id: 10, message: {
      message_id: 7, message_thread_id: 12, date: 1_788_333_600,
      chat: { id: -1001, type: "supergroup", title: "Mia builders", is_forum: true },
      from: { id: 42, is_bot: false, first_name: "Lisa", language_code: "en" },
      text: "@apimasterai_bot hi", entities: [{ offset: 0, length: 16, type: "mention" }],
    } } as never);
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    expect(contexts?.getOnboardingState(42)).toBeNull();
    expect(contexts?.listMemories({ type: "user", userId: 42 })).toEqual([]);
  });

  it("does not trigger onboarding for a task classification", async () => {
    const { bot, calls } = setup(routed({ conversation_mode: "task", onboarding_opportunity: true, final_response: "答案是 42。" }));
    await bot.handleUpdate({ update_id: 20, message: {
      message_id: 1, date: 1_788_333_600, chat: { id: 42, type: "private", first_name: "Lisa" },
      from: { id: 42, is_bot: false, first_name: "Lisa", language_code: "zh-CN" }, text: "计算 6 乘 7",
    } } as never);
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    expect(contexts?.getOnboardingState(42)).toMatchObject({ promptCount: 0 });
  });
});
