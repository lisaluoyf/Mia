import { describe, expect, it } from "vitest";

import { isMiaIntroductionRequest, miaIntroduction, MIA_PRODUCT_FACTS_PROMPT } from "../src/identity.js";
import { miaResponsePlainText } from "../src/presentation/schema.js";

describe("Mia identity", () => {
  it.each([
    "向大家介绍一下你自己",
    "你是谁？",
    "你都能做什么",
    "Mia - 自我介绍",
    "What can you do?",
  ])("recognizes a direct Mia introduction request: %s", (text) => {
    expect(isMiaIntroductionRequest(text)).toBe(true);
  });

  it.each([
    "帮我写一份自我介绍",
    "介绍一下 APIMaster API",
    "你能帮我写个公告吗？",
    "你是什么模型？",
  ])("does not intercept an ordinary user task: %s", (text) => {
    expect(isMiaIntroductionRequest(text)).toBe(false);
  });

  it("uses the reviewed Simplified Chinese copy exactly", () => {
    expect(miaResponsePlainText(miaIntroduction("zh-CN"))).toBe(`我是 Mia，APIMaster 的 Telegram AI 助理

我能：

💬 对话和查询实时信息

🖼 生成图片、修改图片

✨ 生成Telegram 贴纸

🎬 创作视频`);
  });

  it("keeps an explicit product allowlist for non-introduction answers", () => {
    expect(MIA_PRODUCT_FACTS_PROMPT).toContain("只能依据以上事实回答");
    expect(MIA_PRODUCT_FACTS_PROMPT).toContain("不要声称拥有以上列表之外的外部工具");
  });
});
