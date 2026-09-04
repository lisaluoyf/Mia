import { afterEach, describe, expect, it, vi } from "vitest";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import { DebugRecorder } from "../src/debug/recorder.js";
import { DebugStore } from "../src/debug/store.js";
import { createLogger } from "../src/logger.js";
import { MediaStore } from "../src/media/store.js";
import { richMessagePlainText } from "../src/presentation/rich-message-text.js";
import { createBot } from "../src/telegram/bot.js";

const botInfo = {
  id: 100, is_bot: true, first_name: "Mia", username: "MiaAssistantBot",
  can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
};

describe("Telegram Rich Message context", () => {
  let mediaStore: MediaStore | undefined;
  let debugStore: DebugStore | undefined;

  afterEach(() => {
    mediaStore?.close();
    debugStore?.close();
  });

  it("extracts readable text from nested native blocks", () => {
    expect(richMessagePlainText([
      { type: "heading", size: 2, text: "本周总结" },
      {
        type: "table",
        cells: [
          [{ text: "事项", is_header: true, align: "left", valign: "middle" }, { text: "状态", is_header: true, align: "left", valign: "middle" }],
          [{ text: "上线", align: "left", valign: "middle" }, { text: "完成", align: "left", valign: "middle" }],
        ],
      },
      {
        type: "details", summary: "补充",
        blocks: [{ type: "paragraph", text: [{ type: "bold", text: "注意" }, "：明天复查"] }],
      },
    ])).toBe("本周总结\n\n事项 | 状态\n上线 | 完成\n\n补充\n注意：明天复查");
  });

  it("stores and understands a forwarded Rich Message, then persists Mia's Rich reply", async () => {
    mediaStore = new MediaStore(":memory:");
    debugStore = new DebugStore(":memory:");
    const saveMessage = vi.fn();
    const chat = vi.fn().mockResolvedValue("看到了，这是一份两项对比。");
    const bot = createBot("123:test", {
      client: {
        resolveAPIKey: vi.fn().mockResolvedValue("user-key"),
        chat,
      } as unknown as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn().mockReturnValue({ chatModel: "gpt-5.4" }) },
      contexts: {
        upsertUser: vi.fn(), upsertChat: vi.fn(), upsertMember: vi.fn(), saveMessage,
      },
      mediaStore,
      debug: new DebugRecorder(debugStore, [42]),
    });
    bot.botInfo = botInfo;
    bot.api.config.use((_previous, method, payload) => {
      if (method === "sendChatAction") return Promise.resolve({ ok: true, result: true } as never);
      if (method === "sendRichMessage") {
        const input = payload as unknown as Record<string, unknown>;
        return Promise.resolve({ ok: true, result: {
          message_id: 12, date: 1_788_333_601,
          chat: { id: 42, type: "private", first_name: "Roma" },
          from: botInfo,
          rich_message: input.rich_message,
        } } as never);
      }
      throw new Error(`Unexpected Telegram method: ${method}`);
    });

    await bot.handleUpdate({
      update_id: 11,
      message: {
        message_id: 11, date: 1_788_333_600,
        chat: { id: 42, type: "private", first_name: "Roma" },
        from: { id: 42, is_bot: false, first_name: "Roma", language_code: "zh-CN" },
        rich_message: {
          blocks: [{
            type: "table",
            cells: [
              [{ text: "模型", is_header: true, align: "left", valign: "middle" }, { text: "速度", is_header: true, align: "left", valign: "middle" }],
              [{ text: "A", align: "left", valign: "middle" }, { text: "快", align: "left", valign: "middle" }],
            ],
          }],
        },
      },
    } as never);

    expect(chat).toHaveBeenCalledWith("user-key", "gpt-5.4", "模型 | 速度\nA | 快");
    expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 11,
      contentType: "rich_message",
      text: "模型 | 速度\nA | 快",
    }));
    expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 12,
      contentType: "rich_message",
      text: "看到了，这是一份两项对比。",
    }));

    await bot.handleUpdate({
      update_id: 12,
      edited_message: {
        message_id: 11, date: 1_788_333_600, edit_date: 1_788_333_602,
        chat: { id: 42, type: "private", first_name: "Roma" },
        from: { id: 42, is_bot: false, first_name: "Roma", language_code: "zh-CN" },
        rich_message: { blocks: [{ type: "paragraph", text: "修正后的转发内容" }] },
      },
    } as never);
    expect(saveMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      messageId: 11,
      contentType: "rich_message",
      text: "修正后的转发内容",
      editedAt: new Date(1_788_333_602_000).toISOString(),
    }));
    expect(chat).toHaveBeenCalledOnce();

    const debugRequest = debugStore.list(42)[0];
    expect(debugRequest).toMatchObject({
      status: "succeeded",
      responsePreview: "看到了，这是一份两项对比。",
    });
    const details = debugRequest?.details as {
      presentation?: { deliveryMode?: unknown; chunkCount?: unknown; fallbackReasons?: unknown; richMessages?: unknown };
    } | null;
    expect(details?.presentation?.deliveryMode).toBe("rich_message");
    expect(details?.presentation?.chunkCount).toBe(1);
    expect(details?.presentation?.fallbackReasons).toEqual([]);
    expect(Array.isArray(details?.presentation?.richMessages)).toBe(true);
  });
});
