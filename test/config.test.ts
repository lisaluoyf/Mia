import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const requiredEnvironment = {
  TELEGRAM_BOT_TOKEN: "123:test-token",
  APIMASTER_BASE_URL: "https://apimaster.example",
  APIMASTER_IDENTITY_BASE_URL: "http://127.0.0.1:3000",
  MIA_INTERNAL_SERVICE_KEY: "internal-test-key-long-enough",
};

describe("Mia configuration", () => {
  it("fails fast without the guest text-chat Token", () => {
    expect(() => loadConfig(requiredEnvironment)).toThrow();
  });

  it("accepts a deployment-only guest Token and fixes its model to GPT-5.4", () => {
    const config = loadConfig({ ...requiredEnvironment, MIA_GUEST_CHAT_API_KEY: "guest-test-key" });
    expect(config.miaGuestChatApiKey).toBe("guest-test-key");
    expect(config.miaGuestChatModel).toBe("gpt-5.4");
    expect(() => loadConfig({
      ...requiredEnvironment,
      MIA_GUEST_CHAT_API_KEY: "guest-test-key",
      MIA_GUEST_CHAT_MODEL: "another-model",
    })).toThrow();
  });

  it("uses a separate five-minute ceiling for interruptible Agent model work", () => {
    expect(loadConfig({ ...requiredEnvironment, MIA_GUEST_CHAT_API_KEY: "guest-test-key" }).agentTimeoutMs).toBe(300_000);
    expect(() => loadConfig({ ...requiredEnvironment, MIA_GUEST_CHAT_API_KEY: "guest-test-key", MIA_AGENT_TIMEOUT_MS: "600001" })).toThrow();
  });

  it("keeps the no-message Agent Loop monitor opt-in with a bounded cadence", () => {
    const config = loadConfig({ ...requiredEnvironment, MIA_GUEST_CHAT_API_KEY: "guest-test-key" });
    expect(config.agentSmokeEnabled).toBe(false);
    expect(config.agentSmokeUserId).toBeNull();
    expect(config.agentSmokeModel).toBe("gpt-5.6-luna");
    expect(config.agentSmokeIntervalMs).toBe(21_600_000);
    expect(() => loadConfig({ ...requiredEnvironment, MIA_GUEST_CHAT_API_KEY: "guest-test-key", MIA_AGENT_SMOKE_INTERVAL_MS: "299999" })).toThrow();
  });

  it("accepts explicit administrator debug target identities", () => {
    const config = loadConfig({
      ...requiredEnvironment,
      MIA_GUEST_CHAT_API_KEY: "guest-test-key",
      MIA_DEBUG_ALLOWED_TELEGRAM_IDS: "123, 456, 123, invalid",
    });
    expect(config.debugAllowedTelegramIds).toEqual([123, 456]);
  });
});
