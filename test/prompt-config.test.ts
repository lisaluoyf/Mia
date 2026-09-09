import { afterEach, describe, expect, it } from "vitest";

import { PromptConfigStore } from "../src/prompt-config/store.js";
import { configurePromptReader, contextCompactionInputPrompt, promptText } from "../src/prompts.js";

afterEach(() => configurePromptReader(null));

describe("Prompt configuration", () => {
  it("uses saved text immediately without restarting", () => {
    const store = new PromptConfigStore(":memory:");
    configurePromptReader(store);

    store.save("mia.system", "新的系统 Prompt");
    expect(promptText("mia.system")).toBe("新的系统 Prompt");

    store.save("mia.context-compaction-input", "记忆={{existing_memories}}\n对话={{latest_10_turns_oldest_to_newest}}");
    expect(contextCompactionInputPrompt({ memories: ["A"], summary: null, dialogue: "你好" }))
      .toBe("记忆=[\n  \"A\"\n]\n对话=你好");
    store.close();
  });

  it("rejects only unusable text", () => {
    const store = new PromptConfigStore(":memory:");
    expect(() => store.save("mia.system", "")).toThrow("cannot be empty");
    expect(() => store.save("mia.system", "含有\u0000控制字符")).toThrow("control characters");
    expect(() => store.save("missing", "text")).toThrow("Unknown Prompt");
    store.close();
  });

  it("stores only valid JSON for the editable Mia response schema", () => {
    const store = new PromptConfigStore(":memory:");
    const schema = JSON.stringify({ type: "object", properties: { version: { type: "integer" } } });
    expect(store.save("mia.response-schema", schema).text).toBe(schema);
    expect(() => store.save("mia.response-schema", "not json")).toThrow("valid JSON");
    expect(() => store.save("mia.response-schema", "[]")).toThrow("Schema object");
    store.close();
  });
});
