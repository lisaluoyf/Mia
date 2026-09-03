import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ContextStore } from "../src/storage/store.js";
import type { GroupConversationScope } from "../src/storage/types.js";

const group = { type: "group", chatId: -1001 } as const;
const topic = { type: "topic", chatId: -1001, threadId: 12 } as const;
const otherTopic = { type: "topic", chatId: -1001, threadId: 13 } as const;
const minute = 60_000;

describe("group follow-up store", () => {
  let store: ContextStore | undefined;
  let directory: string | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function createStore(path = ":memory:"): ContextStore {
    store = new ContextStore(path);
    store.upsertUser({
      telegramUserId: 42,
      firstName: "Liz",
      lastName: null,
      username: "liz",
      languageCode: "zh-CN",
      isBot: false,
    });
    store.upsertChat({
      chatId: -1001,
      type: "supergroup",
      title: "Mia builders",
      username: null,
      description: null,
      isForum: true,
    });
    return store;
  }

  it("isolates group and topic sessions and expires exactly ten minutes after the last handling", () => {
    const current = createStore();
    const started = new Date("2026-09-03T10:00:00.000Z");
    current.wakeGroupFollowUp(topic, 42, started);

    expect(current.getActiveGroupFollowUp(topic, new Date(started.getTime() + 9 * minute + 59_999)))
      .toMatchObject({ scope: topic, awakenedByUserId: 42, evaluationCount: 0 });
    expect(current.getActiveGroupFollowUp(group, started)).toBeNull();
    expect(current.getActiveGroupFollowUp(otherTopic, started)).toBeNull();
    expect(current.getActiveGroupFollowUp(topic, new Date(started.getTime() + 10 * minute))).toBeNull();
  });

  it("only extends the session when handling is explicitly recorded", () => {
    const current = createStore();
    const started = new Date("2026-09-03T10:00:00.000Z");
    current.wakeGroupFollowUp(group, 42, started);
    expect(current.claimGroupFollowUpEvaluation(group, new Date(started.getTime() + 9 * minute)).outcome).toBe("claimed");
    expect(current.getActiveGroupFollowUp(group, new Date(started.getTime() + 10 * minute))).toBeNull();

    current.wakeGroupFollowUp(group, 42, started);
    current.markGroupFollowUpHandled(group, new Date(started.getTime() + 9 * minute));
    expect(current.getActiveGroupFollowUp(group, new Date(started.getTime() + 18 * minute)))?.toMatchObject({
      lastHandledAt: "2026-09-03T10:09:00.000Z",
    });
    expect(current.getActiveGroupFollowUp(group, new Date(started.getTime() + 19 * minute))).toBeNull();
  });

  it("claims at most thirty automatic evaluations in a fixed ten-minute window", () => {
    const current = createStore();
    const started = new Date("2026-09-03T10:00:00.000Z");
    current.wakeGroupFollowUp(group, 42, started);
    for (let index = 0; index < 30; index += 1) {
      expect(current.claimGroupFollowUpEvaluation(group, new Date(started.getTime() + index * 100)).outcome)
        .toBe("claimed");
    }
    expect(current.claimGroupFollowUpEvaluation(group, new Date(started.getTime() + minute)).outcome)
      .toBe("rate_limited");

    current.markGroupFollowUpHandled(group, new Date(started.getTime() + 9 * minute));
    expect(current.claimGroupFollowUpEvaluation(group, new Date(started.getTime() + 10 * minute)).outcome)
      .toBe("claimed");
  });

  it("persists wake state across store restarts", () => {
    directory = mkdtempSync(join(tmpdir(), "mia-follow-up-store-"));
    const databasePath = join(directory, "mia.sqlite");
    let current = createStore(databasePath);
    const started = new Date("2026-09-03T10:00:00.000Z");
    current.wakeGroupFollowUp(topic, 42, started);
    current.close();
    store = undefined;

    current = new ContextStore(databasePath);
    store = current;
    expect(current.getActiveGroupFollowUp(topic, new Date(started.getTime() + minute)))
      .toMatchObject({ scope: topic, awakenedByUserId: 42 });
  });

  it("can explicitly expire an active session", () => {
    const current = createStore();
    const scope: GroupConversationScope = group;
    current.wakeGroupFollowUp(scope, 42, new Date("2026-09-03T10:00:00.000Z"));
    expect(current.expireGroupFollowUp(scope)).toBe(true);
    expect(current.getActiveGroupFollowUp(scope, new Date("2026-09-03T10:01:00.000Z"))).toBeNull();
  });
});
