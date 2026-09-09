import { describe, expect, it, vi } from "vitest";

import { ChatCompletionError, ResolverError } from "../src/clients/apimaster.js";
import { AgentModelError } from "../src/agent/model.js";
import { ChatCredentialResolver, withGuestTextRequestFallback } from "../src/credentials/chat.js";

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

  it("reads the configured guest model again for every fallback", async () => {
    let guestModel = "gpt-5.4";
    const resolver = new ChatCredentialResolver({
      resolveAPIKey: vi.fn().mockRejectedValue(new ResolverError("telegram_not_bound")),
    }, { apiKey: "guest-test-key", model: () => guestModel });

    await expect(resolver.resolve(42, "selected-chat")).resolves.toMatchObject({ model: "gpt-5.4" });
    guestModel = "gpt-5.5";
    await expect(resolver.resolve(42, "selected-chat")).resolves.toMatchObject({ model: "gpt-5.5" });
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

  it("retries a user text request once with the guest Token after a billing failure", () => {
    const resolver = new ChatCredentialResolver({ resolveAPIKey: vi.fn() }, { apiKey: "guest-test-key", model: "gpt-5.4" });
    const user = { apiKey: "user-test-key", model: "grok-4.5", source: "user" as const, fallbackReason: null };
    expect(resolver.fallbackForTextRequest(user, new ChatCompletionError(403, "insufficient_user_quota"))).toEqual({
      apiKey: "guest-test-key", model: "gpt-5.4", source: "guest", fallbackReason: "user_request_failed",
    });
  });

  it("does not bypass an explicit account governance rejection", () => {
    const resolver = new ChatCredentialResolver({ resolveAPIKey: vi.fn() }, { apiKey: "guest-test-key", model: "gpt-5.4" });
    const user = { apiKey: "user-test-key", model: "grok-4.5", source: "user" as const, fallbackReason: null };
    expect(resolver.fallbackForTextRequest(user, new ChatCompletionError(403, "risk_denied"))).toBeNull();
  });

  it("uses the guest Token for an Agent Loop billing failure", () => {
    const resolver = new ChatCredentialResolver({ resolveAPIKey: vi.fn() }, { apiKey: "guest-test-key", model: "gpt-5.4" });
    const user = { apiKey: "user-test-key", model: "grok-4.5", source: "user" as const, fallbackReason: null };
    expect(resolver.fallbackForTextRequest(user, new AgentModelError("insufficient_user_quota", false, 403))).toMatchObject({
      apiKey: "guest-test-key", model: "gpt-5.4", source: "guest", fallbackReason: "user_request_failed",
    });
  });

  it("performs exactly one guest retry and forces the guest model", async () => {
    const resolver = new ChatCredentialResolver({ resolveAPIKey: vi.fn() }, { apiKey: "guest-test-key", model: "gpt-5.4" });
    const user = { apiKey: "user-test-key", model: "grok-4.5", source: "user" as const, fallbackReason: null };
    const request = vi.fn()
      .mockRejectedValueOnce(new ChatCompletionError(403, "insufficient_user_quota"))
      .mockResolvedValueOnce("guest response");

    await expect(withGuestTextRequestFallback(resolver, user, request)).resolves.toEqual({
      value: "guest response",
      credential: { apiKey: "guest-test-key", model: "gpt-5.4", source: "guest", fallbackReason: "user_request_failed" },
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([credential]) => credential.apiKey)).toEqual(["user-test-key", "guest-test-key"]);
  });
});
