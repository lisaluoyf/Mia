import { describe, expect, it } from "vitest";

import { miaResponsePlainText, normalizeMiaResponse, type MiaResponse } from "../src/presentation/schema.js";
import { renderTelegramHtml } from "../src/presentation/telegram-html.js";

function response(blocks: MiaResponse["blocks"]): MiaResponse {
  return { version: 1, title: null, blocks, actions: [] };
}

describe("Mia Telegram presentation", () => {
  it("keeps short conversation replies visually quiet", () => {
    const chunks = renderTelegramHtml(response([{
      type: "paragraph", heading: null, emoji: null, text: "当然，可以。",
      items: [], ordered: false, language: null,
    }]));

    expect(chunks).toEqual([{ html: "当然，可以。", plainText: "当然，可以。" }]);
  });

  it("renders weather facts and practical advice with native Telegram emphasis", () => {
    const value: MiaResponse = {
      version: 1,
      title: { text: "北京明天（9 月 4 日）", emoji: "🌤" },
      blocks: [
        {
          type: "facts", heading: null, emoji: null, text: null,
          items: [
            { label: "白天", text: "晴间多云，最高 33°C" },
            { label: "夜间", text: "晴转多云，最低 20°C" },
            { label: "风", text: "北转南风 2–3 级" },
          ],
          ordered: false, language: null,
        },
        {
          type: "paragraph", heading: null, emoji: null,
          text: "早晚温差大，中午热、晚上凉，出门带件薄外套。",
          items: [], ordered: false, language: null,
        },
      ],
      actions: [],
    };

    const [chunk] = renderTelegramHtml(value);
    expect(chunk?.html).toContain("🌤 <b>北京明天（9 月 4 日）</b>");
    expect(chunk?.html).toContain("<b>白天：</b> 晴间多云，最高 33°C");
    expect(chunk?.html).toContain("\n\n早晚温差大");
    expect(chunk?.plainText).not.toContain("<b>");
  });

  it("strips model-authored Markdown and escapes untrusted HTML", () => {
    const value = response([{
      type: "list", heading: "**重点**", emoji: "✅", text: null,
      items: [{ label: "__状态__", text: "A < B & C > D" }],
      ordered: false, language: null,
    }]);

    const normalized = normalizeMiaResponse(value);
    const [chunk] = renderTelegramHtml(normalized);
    expect(chunk?.html).toContain("✅ <b>重点</b>");
    expect(chunk?.html).toContain("● <b>状态</b>：A &lt; B &amp; C &gt; D");
    expect(chunk?.html).not.toContain("**");
    expect(miaResponsePlainText(normalized)).toContain("状态：A < B & C > D");
  });

  it("splits after HTML escaping so every Telegram chunk remains within the limit", () => {
    const chunks = renderTelegramHtml(response([{
      type: "paragraph", heading: null, emoji: null, text: "<&>".repeat(2600),
      items: [], ordered: false, language: null,
    }]));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.html.length <= 4096)).toBe(true);
    expect(chunks.map((chunk) => chunk.plainText).join("")).toBe("<&>".repeat(2600));
  });
});
