import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OnboardingService } from "../src/onboarding/service.js";
import { ContextStore } from "../src/storage/store.js";

describe("Mia private onboarding state", () => {
  let store: ContextStore | undefined;

  afterEach(() => store?.close());

  function setup() {
    store = new ContextStore(":memory:");
    store.upsertUser({ telegramUserId: 42, firstName: "Lisa", lastName: null, username: "lisa", languageCode: "zh-CN", isBot: false });
    store.upsertChat({ chatId: 42, type: "private", title: null, username: "lisa", description: null, isForum: false });
    return { store, service: new OnboardingService(store) };
  }

  function addTurns(current: ContextStore, count: number, from = 1) {
    for (let index = from; index < from + count; index += 1) {
      current.recordCompletedTurn({ chatId: 42, userId: 42, userMessageId: index * 2 - 1, assistantMessageId: index * 2 });
    }
  }

  it("allows two prompts with a 20-turn interval and then stops", () => {
    const { service } = setup();
    expect(service.eligibility(42, 42)).toMatchObject({ eligible: true, currentTurn: 1, promptCount: 0 });
    expect(service.claimPrompt(42, 1)?.promptCount).toBe(1);
    addTurns(store as ContextStore, 19);
    expect(service.eligibility(42, 42)).toMatchObject({ eligible: false, reason: "interval", currentTurn: 20 });
    addTurns(store as ContextStore, 1, 20);
    expect(service.eligibility(42, 42)).toMatchObject({ eligible: true, currentTurn: 21 });
    expect(service.claimPrompt(42, 21)?.promptCount).toBe(2);
    expect(service.eligibility(42, 42)).toMatchObject({ eligible: false, reason: "prompt_limit" });
  });

  it("expires permanently after 100 completed turns", () => {
    const { service } = setup();
    addTurns(store as ContextStore, 100);
    expect(service.eligibility(42, 42)).toMatchObject({ eligible: false, reason: "expired", completedTurns: 100 });
    expect(store?.getOnboardingState(42)?.expiredAt).not.toBeNull();
  });

  it("persists onboarding state across service restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "mia-onboarding-"));
    const path = join(directory, "mia.sqlite");
    try {
      store = new ContextStore(path);
      store.upsertUser({ telegramUserId: 42, firstName: "Lisa", lastName: null, username: "lisa", languageCode: "zh-CN", isBot: false });
      store.upsertChat({ chatId: 42, type: "private", title: null, username: "lisa", description: null, isForum: false });
      new OnboardingService(store).claimPrompt(42, 1);
      store.close();
      store = new ContextStore(path);
      expect(store.getOnboardingState(42)).toMatchObject({ promptCount: 1, firstPromptTurn: 1, lastPromptTurn: 1 });
    } finally {
      store?.close();
      store = undefined;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes explicit profile fields into deduplicated long-term memory", () => {
    const { service } = setup();
    service.claimPrompt(42, 1);
    const role = service.selectRole(42, "Developer", false, 10);
    expect(role.created).toBe(true);
    expect(service.selectRole(42, "Developer", false, 10).created).toBe(false);
    service.applyProfileUpdates(42, 11, { preferredName: "Roma", primaryRole: null, primaryGoal: "Help me build Mia" });
    service.applyProfileUpdates(42, 11, { preferredName: "Roma", primaryRole: null, primaryGoal: "Help me build Mia" });

    expect(store?.getOnboardingState(42)).toMatchObject({ stage: "completed", selectedRole: "Developer", hasPreferredName: true, hasPrimaryGoal: true });
    expect(store?.listMemories({ type: "user", userId: 42 }).map((item) => `${item.category}:${item.content}`).sort()).toEqual([
      "goal:Primary goal: Help me build Mia",
      "identity:Preferred name: Roma",
      "identity:Primary role: Developer",
    ]);
  });

  it("keeps profile and onboarding state when /new clears the conversation", () => {
    const { service } = setup();
    service.claimPrompt(42, 1);
    service.applyProfileUpdates(42, 3, { preferredName: "Roma", primaryRole: "Founder", primaryGoal: "Build Mia" });
    addTurns(store as ContextStore, 1);
    store?.clearConversation({ type: "private", chatId: 42 });
    expect(store?.getOnboardingState(42)?.completedAt).not.toBeNull();
    expect(store?.listMemories({ type: "user", userId: 42 })).toHaveLength(3);
    expect(store?.countSuccessfulPrivateTurns(42, 42)).toBe(1);
    expect(service.eligibility(42, 42).currentTurn).toBe(2);
  });

  it("supports custom roles, partial answers, and deferral without completing", () => {
    const { service } = setup();
    service.claimPrompt(42, 1);
    expect(service.selectRole(42, null, true, 10).state.stage).toBe("awaiting_custom_profile");
    expect(service.selectRole(42, null, true, 10).created).toBe(false);
    service.applyProfileUpdates(42, 11, { preferredName: "Roma", primaryRole: "AI product builder", primaryGoal: null });
    expect(store?.getOnboardingState(42)).toMatchObject({ stage: "awaiting_details", hasPreferredName: true, hasPrimaryGoal: false });
    expect(service.defer(42).stage).toBe("deferred");
  });
});
