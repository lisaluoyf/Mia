import { describe, expect, it } from "vitest";

import { miaIntroductionPanel, miaSettingsLaunch } from "../src/telegram/introduction-panel.js";

describe("Mia introduction panel", () => {
  it("uses callbacks in private chat and opens the existing settings Mini App", () => {
    expect(miaIntroductionPanel("zh-CN", "MiaAssistantBot", {
      privateChat: true,
      miniAppUrl: "https://apimaster.ai/mia/",
    }).inline_keyboard).toEqual([
      [
        { text: "🖼 生成图片", callback_data: "intro_action:image" },
        { text: "🎬 生成视频", callback_data: "intro_action:video" },
      ],
      [
        { text: "✨ 制作贴纸", callback_data: "intro_action:sticker" },
        { text: "⚙️ 模型设置", web_app: { url: "https://apimaster.ai/mia/" } },
      ],
      [
        { text: "💬 聊天", callback_data: "intro_action:chat" },
        { text: "🔍 搜索", callback_data: "intro_action:search" },
      ],
    ]);
  });

  it("takes private-only actions from a group into the bot private chat", () => {
    expect(miaIntroductionPanel("zh-CN", "@MiaAssistantBot", {
      privateChat: false,
      miniAppUrl: "https://apimaster.ai/mia/",
    }).inline_keyboard).toEqual([
      [
        { text: "🖼 生成图片", callback_data: "intro_action:image" },
        { text: "🎬 生成视频", callback_data: "intro_action:video" },
      ],
      [
        { text: "✨ 制作贴纸", url: "https://t.me/MiaAssistantBot?start=sticker" },
        { text: "⚙️ 模型设置", url: "https://t.me/MiaAssistantBot?start=settings" },
      ],
      [
        { text: "💬 聊天", callback_data: "intro_action:chat" },
        { text: "🔍 搜索", callback_data: "intro_action:search" },
      ],
    ]);
  });

  it("creates a web-app launch for settings deep links", () => {
    expect(miaSettingsLaunch("zh-CN", "https://apimaster.ai/mia/").keyboard.inline_keyboard).toEqual([
      [{ text: "打开设置", web_app: { url: "https://apimaster.ai/mia/" } }],
    ]);
  });
});
