import { afterEach, describe, expect, it, vi } from "vitest";

import { FollowUpCoordinator } from "../src/follow-up/coordinator.js";

describe("follow-up coordinator", () => {
  afterEach(() => vi.useRealTimers());

  it("debounces messages for two seconds and groups different senders by scope", async () => {
    vi.useFakeTimers();
    const onBatch = vi.fn().mockResolvedValue(undefined);
    const coordinator = new FollowUpCoordinator<{ sender: number; text: string }>({ onBatch });

    coordinator.enqueue("-1001:12", { sender: 1, text: "first" });
    await vi.advanceTimersByTimeAsync(1_500);
    coordinator.enqueue("-1001:12", { sender: 2, text: "second" });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(onBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(onBatch).toHaveBeenCalledWith("-1001:12", [
      { sender: 1, text: "first" },
      { sender: 2, text: "second" },
    ]);
  });

  it("flushes no later than five seconds after the first message", async () => {
    vi.useFakeTimers();
    const onBatch = vi.fn().mockResolvedValue(undefined);
    const coordinator = new FollowUpCoordinator<string>({ onBatch });
    coordinator.enqueue("group", "one");
    for (let index = 0; index < 4; index += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      coordinator.enqueue("group", `next-${index}`);
    }
    await vi.advanceTimersByTimeAsync(999);
    expect(onBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onBatch).toHaveBeenCalledOnce();
  });

  it("cancels a pending batch when a direct request arrives", async () => {
    vi.useFakeTimers();
    const onBatch = vi.fn().mockResolvedValue(undefined);
    const coordinator = new FollowUpCoordinator<string>({ onBatch });
    coordinator.enqueue("group", "pending");
    coordinator.cancel("group");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onBatch).not.toHaveBeenCalled();
  });

  it("serializes batches within one scope while allowing other scopes to run", async () => {
    vi.useFakeTimers();
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: string[] = [];
    const onBatch = vi.fn(async (key: string, items: readonly string[]) => {
      calls.push(`${key}:${items.join(",")}`);
      if (items[0] === "first") await first;
    });
    const coordinator = new FollowUpCoordinator<string>({ onBatch });

    coordinator.enqueue("same", "first");
    coordinator.enqueue("other", "parallel");
    await vi.advanceTimersByTimeAsync(2_000);
    coordinator.enqueue("same", "second");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual(["same:first", "other:parallel"]);
    releaseFirst?.();
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(calls).toEqual(["same:first", "other:parallel", "same:second"]);
  });
});
