import { describe, expect, it } from "vitest";

import { miaResponsePlainText, normalizeMiaResponse, type MiaResponse } from "../src/presentation/schema.js";
import { renderTelegramHtml } from "../src/presentation/telegram-html.js";
import { renderTelegramRich } from "../src/presentation/telegram-rich.js";

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
    expect(renderTelegramRich(response([{
      type: "paragraph", heading: null, emoji: null, text: "当然，可以。",
      items: [], ordered: false, language: null,
    }]))[0]?.richBlocks).toEqual([{ type: "paragraph", text: "当然，可以。" }]);
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
    expect(chunk?.html).toContain("<blockquote><b>白天：</b> 晴间多云，最高 33°C");
    expect(chunk?.html).toContain("北转南风 2–3 级</blockquote>");
    expect(chunk?.html).toContain("\n\n早晚温差大");
    expect(chunk?.plainText).not.toContain("<b>");
    expect(chunk?.plainText).not.toContain("<blockquote>");
  });

  it("keeps a facts heading outside its visual container", () => {
    const [chunk] = renderTelegramHtml(response([{
      type: "facts", heading: "今日状态", emoji: "✅", text: null,
      items: [{ label: "服务", text: "正常" }],
      ordered: false, language: null,
    }]));

    expect(chunk?.html).toBe("✅ <b>今日状态</b>\n<blockquote><b>服务：</b> 正常</blockquote>");
    expect(chunk?.plainText).toBe("✅ 今日状态\n服务：正常");
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

  it("maps semantic content to native headings, lists, quotes, details, and tables", () => {
    const [chunk] = renderTelegramRich({
      version: 1,
      title: { text: "方案对比", emoji: "📊" },
      blocks: [
        {
          type: "list", heading: "重点", emoji: null, text: null,
          items: [{ label: "速度", text: "方案 A 更快" }], ordered: false, language: null,
        },
        {
          type: "quote", heading: null, emoji: null, text: "先小范围验证。",
          items: [], ordered: false, language: null,
        },
        {
          type: "table", heading: "数据", emoji: null,
          columns: ["方案", "耗时", "结果"],
          rows: [["A", "2 秒", "通过"], ["B", "5 秒", "待优化"]],
          compact: true,
        },
        {
          type: "details", heading: "补充说明", emoji: null, text: "这是次要信息。",
          items: [], ordered: false, language: null,
        },
      ],
      actions: [],
    });

    expect(chunk?.richBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "heading", size: 2, text: "📊 方案对比" }),
      expect.objectContaining({ type: "list" }),
      expect.objectContaining({ type: "blockquote" }),
      expect.objectContaining({ type: "table", is_bordered: true, is_striped: true, is_compact: true }),
      expect.objectContaining({ type: "details", summary: "补充说明" }),
    ]));
    expect(chunk?.plainText).toContain("方案 | 耗时 | 结果");
    expect(chunk?.htmlFallback.length).toBeGreaterThan(0);
  });

  it("keeps untrusted model text as data rather than Telegram markup", () => {
    const [chunk] = renderTelegramRich(response([{
      type: "paragraph", heading: null, emoji: null,
      text: "<tg-button type=\"url\">不要执行</tg-button>",
      items: [], ordered: false, language: null,
    }]));

    expect(chunk?.richBlocks).toEqual([{
      type: "paragraph",
      text: "<tg-button type=\"url\">不要执行</tg-button>",
    }]);
    expect(chunk?.htmlFallback[0]?.html).toContain("&lt;tg-button");
  });

  it("splits large generic tables without dropping rows", () => {
    const rows = Array.from({ length: 20 }, (_, row) =>
      Array.from({ length: 8 }, (_, column) => `R${row + 1}C${column + 1}-${"内容".repeat(120)}`));
    const chunks = renderTelegramRich(response([{
      type: "table", heading: "大表格", emoji: null,
      columns: Array.from({ length: 8 }, (_, index) => `列 ${index + 1}`),
      rows,
      compact: true,
    }]));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk.plainText, "utf8") <= 28_000)).toBe(true);
    const deliveredRows = chunks.flatMap((chunk) => chunk.richBlocks)
      .filter((block) => block.type === "table")
      .reduce((count, block) => count + Math.max(0, block.cells.length - 1), 0);
    expect(deliveredRows).toBe(20);
  });
});
