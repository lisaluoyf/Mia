interface PendingBatch<T> {
  items: T[];
  firstQueuedAt: number;
  timer: NodeJS.Timeout;
}

interface CoordinatorOptions<T> {
  debounceMs?: number;
  maxWaitMs?: number;
  now?: () => number;
  onBatch: (key: string, items: readonly T[]) => Promise<void>;
  onError?: (error: unknown, key: string) => void;
}

export class FollowUpCoordinator<T> {
  private readonly batches = new Map<string, PendingBatch<T>>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;

  constructor(private readonly options: CoordinatorOptions<T>) {
    this.debounceMs = options.debounceMs ?? 2_000;
    this.maxWaitMs = options.maxWaitMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  enqueue(key: string, item: T): void {
    const existing = this.batches.get(key);
    if (existing) {
      existing.items.push(item);
      clearTimeout(existing.timer);
      existing.timer = this.schedule(key, existing.firstQueuedAt);
      return;
    }
    const firstQueuedAt = this.now();
    this.batches.set(key, {
      items: [item],
      firstQueuedAt,
      timer: this.schedule(key, firstQueuedAt),
    });
  }

  cancel(key: string): void {
    const batch = this.batches.get(key);
    if (!batch) return;
    clearTimeout(batch.timer);
    this.batches.delete(key);
  }

  stop(): void {
    for (const batch of this.batches.values()) clearTimeout(batch.timer);
    this.batches.clear();
  }

  private schedule(key: string, firstQueuedAt: number): NodeJS.Timeout {
    const remaining = Math.max(0, this.maxWaitMs - (this.now() - firstQueuedAt));
    const timer = setTimeout(() => this.flush(key), Math.min(this.debounceMs, remaining));
    timer.unref();
    return timer;
  }

  private flush(key: string): void {
    const batch = this.batches.get(key);
    if (!batch) return;
    clearTimeout(batch.timer);
    this.batches.delete(key);
    const previous = this.chains.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.options.onBatch(key, batch.items))
      .catch((error: unknown) => this.options.onError?.(error, key))
      .finally(() => {
        if (this.chains.get(key) === current) this.chains.delete(key);
      });
    this.chains.set(key, current);
  }
}
