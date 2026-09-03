import { describe, expect, it } from "vitest";

import { BOT_LOCALES, botText } from "../src/telegram/localization.js";

describe("media processing status copy", () => {
  it("has processing copy without unresolved placeholders in every locale", () => {
    for (const locale of BOT_LOCALES) {
      const text = botText(locale, "stillProcessing", { progress: "" });
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/\{[a-z_]+\}/i);
    }
  });

  it("does not describe processing as queued in Simplified Chinese", () => {
    const text = botText("zh-hans", "stillProcessing", { progress: "" });
    expect(text).toContain("处理中");
    expect(text).not.toContain("排队");
  });
});
