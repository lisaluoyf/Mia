import { describe, expect, it } from "vitest";

import { normalizeMiaResponse, type MiaResponse } from "../src/presentation/schema.js";
import { renderTelegramHtml } from "../src/presentation/telegram-html.js";

describe("Mia malformed presentation recovery", () => {
  it("recovers paragraph text that the model placed in items", () => {
    const value: MiaResponse = {
      version: 1,
      title: null,
      blocks: [{
        type: "paragraph",
        heading: null,
        emoji: "🖼️",
        text: null,
        items: [{
          label: null,
          text: "能。我可以帮你生图，也可以基于你发的图片做改图、重绘、换场景、做贴纸。",
        }],
        ordered: false,
        language: "zh-hans",
      }],
      actions: ["image_edit"],
    };

    const normalized = normalizeMiaResponse(value);
    expect(normalized.blocks).toEqual([expect.objectContaining({
      type: "paragraph",
      text: "能。我可以帮你生图，也可以基于你发的图片做改图、重绘、换场景、做贴纸。",
      items: [],
    })]);
    expect(renderTelegramHtml(value)).toEqual([{
      html: "能。我可以帮你生图，也可以基于你发的图片做改图、重绘、换场景、做贴纸。",
      plainText: "能。我可以帮你生图，也可以基于你发的图片做改图、重绘、换场景、做贴纸。",
    }]);
  });

  it("preserves labels while recovering multiple misplaced paragraph items", () => {
    const value: MiaResponse = {
      version: 1,
      title: null,
      blocks: [{
        type: "paragraph",
        heading: null,
        emoji: null,
        text: null,
        items: [
          { label: "能力", text: "可以生图" },
          { label: null, text: "直接描述画面即可。" },
        ],
        ordered: false,
        language: "zh-hans",
      }],
      actions: [],
    };

    expect(renderTelegramHtml(value)[0]?.plainText).toBe("能力：可以生图\n直接描述画面即可。");
  });

  it("does not replace valid paragraph text with stale items", () => {
    const value: MiaResponse = {
      version: 1,
      title: null,
      blocks: [{
        type: "paragraph",
        heading: null,
        emoji: null,
        text: "以正文为准。",
        items: [{ label: null, text: "不应重复展示" }],
        ordered: false,
        language: "zh-hans",
      }],
      actions: [],
    };

    expect(renderTelegramHtml(value)[0]?.plainText).toBe("以正文为准。");
  });
});
