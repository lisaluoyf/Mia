import { describe, expect, it } from "vitest";

import { splitText } from "../src/telegram/split-text.js";

describe("splitText", () => {
  it("keeps every Telegram reply within the limit", () => {
    const chunks = splitText("a".repeat(9000));
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
    expect(chunks.join("")).toBe("a".repeat(9000));
  });

  it("prefers a nearby word boundary", () => {
    expect(splitText("one two three", 8)).toEqual(["one two", "three"]);
  });
});
