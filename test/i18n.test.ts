import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Mini App translations", () => {
  it("keeps all 25 language packs aligned with English", () => {
    const directory = resolve("web/src/i18n");
    const files = readdirSync(directory).filter((file) => file.endsWith(".json")).sort();
    expect(files).toHaveLength(25);
    const english = JSON.parse(readFileSync(resolve(directory, "en.json"), "utf8")) as Record<string, unknown>;
    const expectedKeys = Object.keys(english).sort();
    for (const file of files) {
      const messages = JSON.parse(readFileSync(resolve(directory, file), "utf8")) as Record<string, unknown>;
      expect(Object.keys(messages).sort(), file).toEqual(expectedKeys);
      expect(Object.values(messages).every((message) => typeof message === "string" && message.length > 0), file).toBe(true);
    }
  });
});
