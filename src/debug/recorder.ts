import type { DebugStore } from "./store.js";
import type { FinishDebugRequest, StartDebugRequest } from "./types.js";

export class DebugRecorder {
  private readonly allowed = new Set<number>();

  constructor(private readonly store: DebugStore, telegramUserIds: readonly number[] = []) {
    this.replaceAllowedUsers(telegramUserIds);
  }

  replaceAllowedUsers(telegramUserIds: readonly number[]): void {
    this.allowed.clear();
    for (const id of telegramUserIds) if (Number.isSafeInteger(id) && id > 0) this.allowed.add(id);
  }

  isEnabled(telegramUserId: number): boolean {
    return this.allowed.has(telegramUserId);
  }

  start(input: StartDebugRequest): string | null {
    return this.isEnabled(input.telegramUserId) ? this.store.start(input) : null;
  }

  finish(id: string | null, input: FinishDebugRequest): void {
    if (id) this.store.finish(id, input);
  }
}

