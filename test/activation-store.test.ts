import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ActivationStore } from "../src/activation/store.js";
import { ContextStore } from "../src/storage/store.js";

describe("activation store", () => {
  let directory: string | undefined;
  let contexts: ContextStore | undefined;
  let activation: ActivationStore | undefined;

  afterEach(() => {
    contexts?.close();
    activation?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("limits a silent user to a distinct second activation and cancels it on interaction", () => {
    directory = mkdtempSync(join(tmpdir(), "mia-activation-"));
    const databasePath = join(directory, "mia.sqlite");
    contexts = new ContextStore(databasePath);
    activation = new ActivationStore(databasePath);
    contexts.upsertUser({ telegramUserId: 42, firstName: "Test", lastName: null, username: null, languageCode: "zh-CN", isBot: false });
    contexts.upsertChat({ chatId: 42, type: "private", title: null, username: null, description: null, isForum: false });
    contexts.saveMessage({
      chatId: 42, messageId: 1, threadId: null, senderUserId: 42, senderChatId: null, replyToMessageId: null,
      contentType: "text", text: "/start", caption: null, entitiesJson: null, mediaFileId: null, mediaUniqueId: null,
      sentAt: "2026-09-08T00:00:00.000Z", editedAt: null,
    });

    const candidate = activation.listFirstCandidates(10)[0]!;
    const sentAt = new Date("2026-09-08T00:20:00.000Z");
    expect(activation.claimDelivery(candidate, 1, "introduction_v1", sentAt)).toBe(true);
    activation.markSent(42, 1, sentAt);
    expect(activation.listSecondCandidates(new Date("2026-09-08T07:00:00.000Z"), 10)).toHaveLength(1);
    activation.markInteraction(42);
    expect(activation.listSecondCandidates(new Date("2026-09-08T07:00:00.000Z"), 10)).toHaveLength(0);
  });

  it("keeps a weather request separate from the recurring subscription", () => {
    directory = mkdtempSync(join(tmpdir(), "mia-activation-weather-"));
    activation = new ActivationStore(join(directory, "mia.sqlite"));
    const location = { name: "Shanghai", country: "China", latitude: 31.23, longitude: 121.47, timezone: "Asia/Shanghai" };
    activation.beginWeatherIntent(42, 42);
    expect(activation.consumeWeatherIntent(42, 42)).toBe(true);
    activation.saveWeatherRequest(42, 42, location);
    const subscription = activation.createWeatherSubscription(42, 8, new Date("2026-09-09T00:00:00.000Z"));
    expect(subscription).toMatchObject({ telegramUserId: 42, deliveryHour: 8, status: "active", location });
  });
});
