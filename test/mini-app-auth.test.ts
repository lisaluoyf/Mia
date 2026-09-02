import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { MiniAppAuthError, verifyTelegramInitData } from "../src/mini-app/auth.js";

const token = "123456:test-token";
const now = 1_800_000_000;

function initData(authDate = now, user = JSON.stringify({ id: 42, first_name: "Mia", language_code: "zh-CN" })) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: "AAE", signature: "telegram-signature", user });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

describe("Telegram Mini App authentication", () => {
  it("returns only a user from correctly signed fresh initData", () => {
    expect(verifyTelegramInitData(initData(), token, 3600, now)).toEqual({
      id: 42,
      first_name: "Mia",
      language_code: "zh-CN",
    });
  });

  it("rejects tampered, expired, and malformed initData", () => {
    expect(() => verifyTelegramInitData(initData().replace("Mia", "Mio"), token, 3600, now)).toThrow(MiniAppAuthError);
    expect(() => verifyTelegramInitData(initData(now - 3601), token, 3600, now)).toThrowError(/expired/);
    expect(() => verifyTelegramInitData(initData(now, "{"), token, 3600, now)).toThrowError(/invalid/);
  });
});
