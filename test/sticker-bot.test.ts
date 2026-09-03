import { afterEach, describe, expect, it, vi } from "vitest";

import type { APIMasterClient } from "../src/clients/apimaster.js";
import type { IntentRouter } from "../src/intent/router.js";
import { createLogger } from "../src/logger.js";
import { MediaStore } from "../src/media/store.js";
import { createBot } from "../src/telegram/bot.js";

const botInfo = {
  id: 100,
  is_bot: true,
  first_name: "Mia",
  username: "MiaAssistantBot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

function contexts() {
  return {
    upsertUser: vi.fn(),
    upsertChat: vi.fn(),
    upsertMember: vi.fn(),
    saveMessage: vi.fn(),
  };
}

function installApi(bot: ReturnType<typeof createBot>) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  bot.api.config.use((_previous, method, payload) => {
    const data = payload as unknown as Record<string, unknown>;
    calls.push({ method, payload: data });
    if (method === "sendMessage") {
      const chatId = Number(data.chat_id);
      return Promise.resolve({
        ok: true,
        result: {
          message_id: 900 + calls.length,
          date: 1_788_333_601,
          chat: chatId > 0
            ? { id: chatId, type: "private", first_name: "Liz" }
            : { id: chatId, type: "supergroup", title: "Mia group" },
          from: botInfo,
          text: typeof data.text === "string" ? data.text : "",
        },
      } as never);
    }
    return Promise.resolve({ ok: true, result: true } as never);
  });
  return calls;
}

function update(chatId: number, caption: string | undefined, updateId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: 7,
      date: 1_788_333_600,
      chat: chatId > 0
        ? { id: chatId, type: "private", first_name: "Liz" }
        : { id: chatId, type: "supergroup", title: "Mia group" },
      from: { id: 42, is_bot: false, first_name: "Liz", language_code: "zh-CN" },
      photo: [{ file_id: "photo", file_unique_id: "photo-unique", width: 1024, height: 1024 }],
      ...(caption === undefined ? {} : { caption }),
      ...(chatId < 0 ? { caption_entities: [{ type: "mention", offset: 0, length: 16 }] } : {}),
    },
  };
}

describe("Telegram sticker intent", () => {
  let store: MediaStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    vi.clearAllMocks();
  });

  function setup() {
    store = new MediaStore(":memory:");
    const classify = vi.fn();
    const resolveAPIKey = vi.fn().mockResolvedValue("user-key");
    const getSnapshot = vi.fn().mockResolvedValue({
      apimasterUserId: "user-1",
      models: [],
      settings: { chatModel: null, visionModel: null, imageModel: "gpt-image-2", videoModel: null },
      unavailable: [],
    });
    const bot = createBot("123:test", {
      client: { resolveAPIKey } as unknown as APIMasterClient,
      logger: createLogger("silent"),
      settings: { getPreferences: vi.fn(), getSnapshot },
      contexts: contexts(),
      router: { model: "gpt-5.4", classify } as unknown as IntentRouter,
      mediaStore: store,
      botToken: "123:test",
    });
    bot.botInfo = botInfo;
    const calls = installApi(bot);
    return { bot, calls, classify, resolveAPIKey };
  }

  it("creates exactly one sticker-mode image job for an explicit private photo", async () => {
    const { bot, classify, resolveAPIKey } = setup();

    await bot.handleUpdate(update(42, "把它做成点赞贴纸", 1001) as never);

    const job = store?.getJobByIdempotencyKey("message:42:7");
    expect(classify).not.toHaveBeenCalled();
    expect(resolveAPIKey).toHaveBeenCalledWith(42, "gpt-image-2");
    expect(job).toMatchObject({
      telegramUserId: 42,
      chatId: 42,
      type: "image_edit",
      status: "queued",
      options: { aspectRatio: "1:1", outputMode: "telegram_sticker", stickerTitle: "Liz | Mia" },
    });
    expect(job?.instruction).toContain("one polished Telegram sticker");
    expect(store?.listJobInputs(job?.id ?? 0)).toHaveLength(1);
  });

  it("does not create or classify a bare private photo", async () => {
    const { bot, classify, resolveAPIKey, calls } = setup();

    await bot.handleUpdate(update(42, undefined, 1002) as never);

    expect(store?.getJobByIdempotencyKey("message:42:7")).toBeNull();
    expect(classify).not.toHaveBeenCalled();
    expect(resolveAPIKey).not.toHaveBeenCalled();
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text).toContain("分析这张图片");
  });

  it("keeps sticker generation disabled in groups", async () => {
    const { bot, classify, resolveAPIKey, calls } = setup();

    await bot.handleUpdate(update(-1001, "@MiaAssistantBot 做贴纸", 1003) as never);

    expect(store?.getJobByIdempotencyKey("message:-1001:7")).toBeNull();
    expect(classify).not.toHaveBeenCalled();
    expect(resolveAPIKey).not.toHaveBeenCalled();
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text).toContain("只支持和 Mia 私聊");
  });
});
