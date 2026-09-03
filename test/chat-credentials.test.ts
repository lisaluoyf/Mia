import { describe, expect, it, vi } from "vitest";

import { ResolverError } from "../src/clients/apimaster.js";
import { ChatCredentialResolver } from "../src/credentials/chat.js";

describe("guest text-chat credentials", () => {
  it("keeps a bound user's selected model and own Key", async () => {
    const resolver = new ChatCredentialResolver({
      resolveAPIKey: vi.fn().mockResolvedValue("user-test-key"),
    }, { apiKey: "guest-test-key", model: "gpt-5.4" });

    await expect(resolver.resolve(42, "selected-chat")).resolves.toEqual({
      apiKey: "user-test-key",
      model: "selected-chat",
      source: "user",
      fallbackReason: null,
    });
  });

  it("uses the guest GPT-5.4 Token only for unbound users", async () => {
    const resolveAPIKey = vi.fn().mockRejectedValue(new ResolverError("telegram_not_bound"));
    const resolver = new ChatCredentialResolver({ resolveAPIKey }, { apiKey: "guest-test-key", model: "gpt-5.4" });

    await expect(resolver.resolve(42, "gpt-5.4")).resolves.toEqual({
      apiKey: "guest-test-key",
      model: "gpt-5.4",
      source: "guest",
      fallbackReason: "telegram_not_bound",
    });
  });

  it("preserves the existing user-model fallback before using the guest Token", async () => {
    const resolveAPIKey = vi.fn()
      .mockRejectedValueOnce(new ResolverError("no_usable_api_key"))
      .mockResolvedValueOnce("user-default-key");
    const resolver = new ChatCredentialResolver({ resolveAPIKey }, { apiKey: "guest-test-key", model: "gpt-5.4" });

    await expect(resolver.resolve(42, "selected-chat", "default-chat")).resolves.toEqual({
      apiKey: "user-default-key",
      model: "default-chat",
      source: "user",
      fallbackReason: null,
    });
    expect(resolveAPIKey).toHaveBeenNthCalledWith(1, 42, "selected-chat");
    expect(resolveAPIKey).toHaveBeenNthCalledWith(2, 42, "default-chat");
  });

  it("uses the guest Token when neither the selected nor default user model has a usable Key", async () => {
    const resolveAPIKey = vi.fn().mockRejectedValue(new ResolverError("no_usable_api_key"));
    const resolver = new ChatCredentialResolver({ resolveAPIKey }, { apiKey: "guest-test-key", model: "gpt-5.4" });

    await expect(resolver.resolve(42, "selected-chat", "default-chat")).resolves.toMatchObject({
      apiKey: "guest-test-key",
      model: "gpt-5.4",
      source: "guest",
      fallbackReason: "no_usable_api_key",
    });
    expect(resolveAPIKey).toHaveBeenCalledTimes(2);
  });

  it.each(["user_disabled", "service_unavailable"] as const)(
    "does not use the guest Token for %s",
    async (code) => {
      const resolver = new ChatCredentialResolver({
        resolveAPIKey: vi.fn().mockRejectedValue(new ResolverError(code)),
      }, { apiKey: "guest-test-key", model: "gpt-5.4" });

      await expect(resolver.resolve(42, "gpt-5.4")).rejects.toMatchObject({ code });
    },
  );
});
