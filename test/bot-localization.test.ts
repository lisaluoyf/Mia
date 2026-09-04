import { describe, expect, it } from "vitest";

import {
  BOT_LOCALES,
  botText,
  mediaJobLocale,
  resolveBotLocale,
  type BotMessageKey,
} from "../src/telegram/localization.js";
import { ONBOARDING_ROLES, onboardingCopy } from "../src/onboarding/localization.js";

describe("Telegram bot localization", () => {
  it("maps Telegram language variants to the supported locale set", () => {
    expect(BOT_LOCALES).toHaveLength(25);
    expect(new Set(BOT_LOCALES).size).toBe(25);
    expect(resolveBotLocale("zh-hans")).toBe("zh-CN");
    expect(resolveBotLocale("zh_Hant_TW")).toBe("zh-TW");
    expect(resolveBotLocale("pt-BR")).toBe("pt-BR");
    expect(resolveBotLocale("de-DE")).toBe("de");
    expect(resolveBotLocale("unknown")).toBe("en");
  });

  it("localizes onboarding questions and all role buttons for all 25 locales", () => {
    for (const locale of BOT_LOCALES) {
      const copy = onboardingCopy(locale);
      expect(copy.roleQuestion.length).toBeGreaterThan(10);
      expect(copy.other.length).toBeGreaterThan(0);
      expect(copy.later.length).toBeGreaterThan(0);
      for (const role of ONBOARDING_ROLES) expect(copy.roles[role].length).toBeGreaterThan(0);
      if (locale !== "en") expect(copy.roleQuestion).not.toBe(onboardingCopy("en").roleQuestion);
    }
  });

  it("localizes the complete Simplified Chinese media lifecycle", () => {
    expect(botText("zh-hans", "settings")).toBe("设置");
    expect(botText("zh-hans", "queuedImage")).toBe("图片生成任务已排队……");
    expect(botText("zh-hans", "generatingNewImage")).toBe("正在生成新图片……");
    expect(botText("zh-hans", "submitted")).toBe("已提交，生成完成后 Mia 会把结果发送到这里。");
    expect(botText("zh-hans", "imageReady")).toBe("图片已生成");
    expect(botText("zh-hans", "generateAnother")).toBe("再生成一张");
    expect(botText("zh-hans", "continueEditing")).toBe("继续修改");
    expect(botText("zh-hans", "downloadOriginal")).toBe("下载原图");
    expect(botText("zh-hans", "share")).toBe("分享到 X");
    expect(botText("zh-hans", "noUsableKey", { model: "gpt-image-2" }))
      .toContain("gpt-image-2");
    expect(mediaJobLocale({ locale: "zh-hans" })).toBe("zh-CN");
  });

  it("localizes the settings menu label for every advertised locale", () => {
    for (const locale of BOT_LOCALES) {
      const translated = botText(locale, "settings");
      expect(translated.length, locale).toBeGreaterThan(0);
      if (locale !== "en") expect(translated, locale).not.toBe(botText("en", "settings"));
    }
  });

  it("uses processing language for media work without exposing the internal queue", () => {
    const text = botText("zh-hans", "stillProcessing", { progress: "" });
    expect(text).toContain("处理中");
    expect(text).not.toContain("排队");
  });

  it("has localized core asynchronous media copy for every advertised locale", () => {
    const coreKeys: BotMessageKey[] = [
      "queuedImage",
      "submitted",
      "imageReady",
      "videoReady",
      "generateAgain",
      "generateAnother",
      "continueEditing",
      "downloadOriginal",
      "share",
      "stillProcessing",
      "generationFailed",
      "temporaryError",
      "activeLimit",
    ];
    for (const locale of BOT_LOCALES) {
      for (const key of coreKeys) {
        const translated = botText(locale, key, { progress: " (50%)" });
        expect(translated.length, `${locale}:${key}`).toBeGreaterThan(0);
        expect(translated, `${locale}:${key}`).not.toMatch(/\{[a-z_]+\}/i);
        if (locale !== "en") expect(translated, `${locale}:${key}`).not.toBe(botText("en", key, { progress: " (50%)" }));
      }
    }
  });

  it("localizes every media activation message and button for all 25 locales", () => {
    const accessKeys: BotMessageKey[] = [
      "mediaBindRequired",
      "mediaTokenRequired",
      "mediaTopUpRequired",
      "registerAndBindButton",
      "createTokenButton",
      "topUpButton",
    ];
    for (const locale of BOT_LOCALES) {
      for (const key of accessKeys) {
        const translated = botText(locale, key);
        expect(translated.length, `${locale}:${key}`).toBeGreaterThan(2);
        if (locale !== "en") expect(translated, `${locale}:${key}`).not.toBe(botText("en", key));
      }
    }
  });
});
