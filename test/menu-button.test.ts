import { describe, expect, it } from "vitest";

import { settingsMenuButton } from "../src/telegram/menu-button.js";

describe("Telegram settings menu button", () => {
  it("uses the user's Telegram language and keeps the Mini App URL", () => {
    expect(settingsMenuButton("zh-hans", "https://apimaster.ai/mia/")).toEqual({
      type: "web_app",
      text: "设置",
      web_app: { url: "https://apimaster.ai/mia/" },
    });
    expect(settingsMenuButton("es", "https://apimaster.ai/mia/").text).toBe("Ajustes");
    expect(settingsMenuButton("unknown", "https://apimaster.ai/mia/").text).toBe("Settings");
  });
});
