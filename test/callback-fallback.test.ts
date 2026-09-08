import { afterEach, describe, expect, it, vi } from "vitest";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import { createLogger } from "../src/logger.js";
import { MediaStore } from "../src/media/store.js";
import { ContextStore } from "../src/storage/store.js";
import { createBot } from "../src/telegram/bot.js";

describe("Telegram callback fallback", () => {
  let contexts: ContextStore | undefined;
  let mediaStore: MediaStore | undefined;

  afterEach(() => {
    contexts?.close();
    mediaStore?.close();
  });

  it("acknowledges obsolete callback data instead of leaving Telegram loading", async () => {
    contexts = new ContextStore(":memory:");
    mediaStore = new MediaStore(":memory:");
    const bot = createBot("123:test", {
      client: {} as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn() },
      contexts,
      mediaStore,
      botToken: "123:test",
    });
    bot.botInfo = {
      id: 100, is_bot: true, first_name: "Mia", username: "apimasterai_bot",
      can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
      can_connect_to_business: false, has_main_web_app: false,
    };
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    bot.api.config.use((_previous, method, payload) => {
      calls.push({ method, payload });
      return Promise.resolve({ ok: true, result: true } as never);
    });

    await bot.handleUpdate({
      update_id: 501,
      callback_query: {
        id: "obsolete-activation", chat_instance: "preview", data: "activation:weather",
        from: { id: 42, is_bot: false, first_name: "Lisa", language_code: "zh-CN" },
        message: {
          message_id: 7, date: 1_788_884_000,
          chat: { id: 42, type: "private", first_name: "Lisa" },
          from: { id: 100, is_bot: true, first_name: "Mia", username: "apimasterai_bot" },
          text: "想看看天气吗？",
        },
      },
    } as never);

    expect(calls).toEqual([{
      method: "answerCallbackQuery",
      payload: { callback_query_id: "obsolete-activation", text: "这个操作不可用。", show_alert: true },
    }]);
  });
});
