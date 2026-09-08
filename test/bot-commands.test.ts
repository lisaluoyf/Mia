import { describe, expect, it } from "vitest";

import { botCommands } from "../src/telegram/commands.js";

describe("Telegram slash command menu", () => {
  it("registers the public shortcuts in the requested order", () => {
    expect(botCommands("en").map(({ command }) => command)).toEqual([
      "tr",
      "ntr",
      "image",
      "video",
      "sticker",
      "new",
    ]);
  });

  it("localizes Chinese descriptions and falls back to English", () => {
    expect(botCommands("zh-CN")[0]?.description).toBe("进入翻译模式");
    expect(botCommands("unknown")[0]?.description).toBe("Enter translation mode");
  });
});
