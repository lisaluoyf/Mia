import { afterEach, describe, expect, it } from "vitest";

import {
  configurePromptReader,
  promptTemplate,
  promptText,
  resolvePromptLocale,
} from "../src/prompts.js";

describe("prompt localization", () => {
  afterEach(() => configurePromptReader(null));

  it("selects built-in English and Russian prompts by locale and falls back to English", () => {
    expect(resolvePromptLocale("zh-TW")).toBe("zh-CN");
    expect(resolvePromptLocale("ru")).toBe("ru");
    expect(resolvePromptLocale("fr")).toBe("en");

    expect(promptText("mia.system", "en")).toContain("You are Mia");
    expect(promptText("mia.system", "en")).not.toContain("产品身份与能力边界");
    expect(promptText("mia.system", "ru")).toContain("Ты Mia");
    expect(promptText("mia.system", "fr")).toContain("You are Mia");
  });

  it("keeps debug overrides Chinese-only while templates localize independently", () => {
    configurePromptReader({
      get(id: string) {
        return id === "mia.system" ? "中文覆盖规则" : undefined;
      },
    });

    expect(promptText("mia.system", "zh-CN")).toBe("中文覆盖规则");
    expect(promptText("mia.system", "en")).toContain("You are Mia");
    expect(promptText("mia.system", "ru")).toContain("Ты Mia");

    const template = promptTemplate("mia.context-compaction-input", "en", {
      existing_memories: "[]",
      earlier_conversation_summary: "none",
      latest_10_turns_oldest_to_newest: "hello",
    });
    expect(template).toContain("Existing long-term memories:");
    expect(template).toContain("Latest 10 turns of dialogue");
  });
});
