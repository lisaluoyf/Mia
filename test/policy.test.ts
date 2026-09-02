import { describe, expect, it } from "vitest";

import { promptFromMessage, shouldRespond } from "../src/telegram/policy.js";

const bot = { id: 42, username: "MiaAssistantBot" };

describe("Telegram trigger policy", () => {
  it("responds to private text", () => {
    expect(shouldRespond({ chatType: "private", text: "你好" }, bot)).toBe(true);
  });

  it("ignores ordinary group text", () => {
    expect(shouldRespond({ chatType: "group", text: "大家好" }, bot)).toBe(false);
  });

  it("responds when mentioned in a group", () => {
    const text = "@MiaAssistantBot 帮我解释一下";
    const entities = [{ type: "mention", offset: 0, length: 16 }];
    expect(shouldRespond({ chatType: "supergroup", text, entities }, bot)).toBe(true);
    expect(promptFromMessage({ chatType: "supergroup", text, entities }, bot)).toBe("帮我解释一下");
  });

  it("responds to a direct reply to the bot", () => {
    expect(
      shouldRespond({ chatType: "group", text: "继续", repliedToUserId: bot.id }, bot),
    ).toBe(true);
  });
});
