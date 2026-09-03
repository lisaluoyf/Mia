import { describe, expect, it } from "vitest";

import type { GroupSummaryContent } from "../src/context/group-summary.js";
import { renderGroupSummaryHtml } from "../src/telegram/group-summary-html.js";

function emptyContent(): GroupSummaryContent {
  return {
    title: { text: "聊天 <总结> & 进展", sourceMessageIds: [1] },
    overview: null,
    topics: [],
    decisions: [],
    todos: [],
    openQuestions: [],
    participants: [],
    historicalContext: [],
  };
}

describe("group summary Telegram HTML", () => {
  it("escapes model text, uses real HTML bold, and omits empty sections", () => {
    const chunks = renderGroupSummaryHtml({
      ...emptyContent(),
      overview: { text: "A < B & C > D **不是粗体**", sourceMessageIds: [1] },
    }, 17, "zh-CN");
    const html = chunks.join("\n");
    expect(html).toContain("<b>聊天 &lt;总结&gt; &amp; 进展</b>");
    expect(html).toContain("A &lt; B &amp; C &gt; D 不是粗体");
    expect(html).not.toContain("**");
    expect(html).not.toContain("<b>待办</b>");
    expect(html).not.toContain("覆盖说明");
    expect(html).not.toContain("基于 Mia 实际收到的");
    expect(html).not.toMatch(/第\s*\d+\s*轮/);
  });

  it("splits very long escaped content into independently valid chunks under Telegram's limit", () => {
    const chunks = renderGroupSummaryHtml({
      ...emptyContent(),
      topics: [{ title: "超长", detail: "<&>".repeat(3000), sourceMessageIds: [1] }],
      decisions: [{ text: "最后结论", sourceMessageIds: [1] }],
    }, 1, "zh-CN");
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
      expect((chunk.match(/<b>/g) ?? []).length).toBe((chunk.match(/<\/b>/g) ?? []).length);
      expect(chunk).not.toMatch(/<(?!\/?b>)/);
    }
    expect(chunks.join("\n")).toContain("<b>定下来的</b>");
  });

  it("reads as highlights followed by a concise takeaway instead of a report", () => {
    const html = renderGroupSummaryHtml({
      ...emptyContent(),
      overview: { text: "贴纸已经发出，视频还要不要继续由 liz 决定。", sourceMessageIds: [6] },
      topics: [
        { title: "9:37", detail: "确定做 1 张龙猫点赞贴纸，30 元，链接已发出。", sourceMessageIds: [1] },
        { title: "9:58", detail: "视频方案已明确，但还没有开始制作。", sourceMessageIds: [2] },
      ],
      todos: [{ text: "确认是否继续制作视频。", sourceMessageIds: [2] }],
    }, 6, "zh-CN").join("\n");

    expect(html).toContain("● <b>9:37</b>：确定做 1 张龙猫点赞贴纸");
    expect(html).toContain("📌 <b>接下来</b>");
    expect(html.indexOf("9:37")).toBeLessThan(html.indexOf("贴纸已经发出"));
    expect(html).not.toContain("主要话题");
    expect(html).not.toContain("概览");
  });
});
