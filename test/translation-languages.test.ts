import { describe, expect, it } from "vitest";

import {
  TRANSLATION_PICKER_LANGUAGES,
  canonicalTranslationLanguage,
  defaultTranslationPair,
  translationLanguageLabel,
} from "../src/telegram/translation-languages.js";

describe("translation language directory", () => {
  it("uses all 25 localized Mia languages in the picker", () => {
    expect(TRANSLATION_PICKER_LANGUAGES).toHaveLength(25);
    expect(new Set(TRANSLATION_PICKER_LANGUAGES)).toHaveLength(25);
  });

  it("shows compact localized language names in an active pair", () => {
    expect(translationLanguageLabel("zh-CN", "zh-CN")).toBe("\u4e2d\u6587");
    expect(translationLanguageLabel("en", "zh-CN")).toBe("\u82f1\u8bed");
    expect(translationLanguageLabel("zh-CN", "en")).toBe("Chinese");
    expect(translationLanguageLabel("en", "en")).toBe("English");
  });

  it("normalizes legacy stored names and Telegram language variants", () => {
    expect(canonicalTranslationLanguage("Simplified Chinese")).toBe("zh-CN");
    expect(canonicalTranslationLanguage("Chinese (China)")).toBe("zh-CN");
    expect(canonicalTranslationLanguage("\u65e5\u8bed")).toBe("ja");
    expect(canonicalTranslationLanguage("zh-hant")).toBe("zh-TW");
  });

  it("uses the Telegram language as the left side of a new pair", () => {
    expect(defaultTranslationPair("zh-hans")).toEqual({ leftLanguage: "zh-CN", rightLanguage: "en" });
    expect(defaultTranslationPair("en-US")).toEqual({ leftLanguage: "en", rightLanguage: "zh-CN" });
    expect(defaultTranslationPair("es-MX")).toEqual({ leftLanguage: "es", rightLanguage: "en" });
  });
});
