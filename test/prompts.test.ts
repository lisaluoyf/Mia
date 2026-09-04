import { afterEach, describe, expect, it } from "vitest";

import {
  configurePromptReader,
  contextCompactionInputPrompt,
  groupContextCompactionInputPrompt,
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

  it("uses locale-specific empty-summary placeholders in localized templates", () => {
    expect(contextCompactionInputPrompt({ memories: [], summary: null, dialogue: "hello" }, "zh-CN"))
      .toContain("（无）");
    expect(contextCompactionInputPrompt({ memories: [], summary: null, dialogue: "hello" }, "en"))
      .toContain("(none)");
    expect(contextCompactionInputPrompt({ memories: [], summary: null, dialogue: "hello" }, "ru"))
      .toContain("(нет)");

    expect(groupContextCompactionInputPrompt(
      { scope: { type: "group" }, memories: [], summary: null, dialogue: "hello" },
      "en",
    )).toContain("(none)");
    expect(groupContextCompactionInputPrompt(
      { scope: { type: "group" }, memories: [], summary: null, dialogue: "hello" },
      "ru",
    )).toContain("(нет)");
  });

  it("cleans Russian prompt translations without Chinese residue", () => {
    const contextPrompt = promptText("mia.context-compaction", "ru");
    const groupContextInput = promptText("mia.group-context-compaction-input", "ru");
    const groupSummaryInput = promptText("mia.group-summary-input", "ru");

    expect(contextPrompt).not.toContain("整理");
    expect(contextPrompt).toContain("скользящего резюме");
    expect(groupContextInput).not.toContain("watermark summary");
    expect(groupContextInput).toContain("после границы текущей сводки");
    expect(groupSummaryInput).not.toContain("locale вывода");
    expect(groupSummaryInput).toContain("Запрошенный язык вывода");
  });
});
