import { describe, expect, it } from "vitest";

import { activationTemplate } from "../src/activation/templates.js";

describe("activation templates", () => {
  it("uses the branded introduction card with its full six-entry panel", () => {
    expect(activationTemplate("introduction_v1", "zh-CN").keyboard.inline_keyboard).toEqual([
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
    expect(activationTemplate("introduction_v1", "zh-CN").text).toBe(`我是 Mia，APIMaster 的 Telegram AI 助理
我能：
💬 对话和查询实时信息
🖼 生成图片、修改图片
✨ 生成Telegram 贴纸
🎬 创作视频`);
  });

  it("keeps the weather invitation focused on its positive action", () => {
    expect(activationTemplate("weather_invite_v1", "zh-CN").keyboard.inline_keyboard).toEqual([
      [{ text: "查天气", callback_data: "activation:weather" }],
    ]);
  });
});
