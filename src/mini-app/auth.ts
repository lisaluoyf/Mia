import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

const telegramUserSchema = z.object({
  id: z.number().int().positive(),
  first_name: z.string().min(1),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
  photo_url: z.url().optional(),
});

export type TelegramMiniAppUser = z.infer<typeof telegramUserSchema>;

export class MiniAppAuthError extends Error {
  constructor(public readonly code: "missing" | "invalid" | "expired") {
    super(`Telegram Mini App authentication failed: ${code}`);
    this.name = "MiniAppAuthError";
  }
}

function signaturesMatch(actualHex: string, expected: Buffer): boolean {
  if (!/^[0-9a-f]{64}$/i.test(actualHex)) {
    return false;
  }
  const actual = Buffer.from(actualHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyTelegramInitData(
  rawInitData: string | undefined,
  botToken: string,
  maxAgeSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): TelegramMiniAppUser {
  if (!rawInitData) {
    throw new MiniAppAuthError("missing");
  }

  const params = new URLSearchParams(rawInitData);
  const hash = params.get("hash");
  if (!hash) {
    throw new MiniAppAuthError("invalid");
  }
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest();
  if (!signaturesMatch(hash, expectedHash)) {
    throw new MiniAppAuthError("invalid");
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isSafeInteger(authDate) || authDate <= 0 || authDate > nowSeconds + 30) {
    throw new MiniAppAuthError("invalid");
  }
  if (nowSeconds - authDate > maxAgeSeconds) {
    throw new MiniAppAuthError("expired");
  }

  const rawUser = params.get("user");
  if (!rawUser) {
    throw new MiniAppAuthError("invalid");
  }
  let user: unknown;
  try {
    user = JSON.parse(rawUser) as unknown;
  } catch {
    throw new MiniAppAuthError("invalid");
  }
  const parsedUser = telegramUserSchema.safeParse(user);
  if (!parsedUser.success) {
    throw new MiniAppAuthError("invalid");
  }
  return parsedUser.data;
}
