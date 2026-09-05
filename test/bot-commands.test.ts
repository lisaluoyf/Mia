import { describe, expect, it } from "vitest";

import { botCommands } from "../src/telegram/commands.js";

describe("Telegram slash command menu", () => {
  it("registers the public shortcuts in the requested order", () => {
    expect(botCommands("en").map(({ command }) => command)).toEqual([
      "image",
      "video",
      "sticker",
      "new",
      "summary",
      "tr",
      "ntr",
    ]);
  });

  it("localizes Chinese descriptions and falls back to English", () => {
    expect(botCommands("zh-CN")[0]?.description).toBe("生成或编辑图片");
    expect(botCommands("unknown")[0]?.description).toBe("Generate or edit an image");
  });
});
