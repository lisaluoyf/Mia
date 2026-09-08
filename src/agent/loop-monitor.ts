import type { Logger } from "pino";
import type { APIMasterClient } from "../clients/apimaster.js";
import { runAgentLoopSmoke } from "./loop-smoke.js";

export interface AgentLoopMonitorOptions {
  enabled: boolean;
  userId: number | null;
  model: string;
  intervalMs: number;
  failureThreshold: number;
  timeoutMs: number;
  baseUrl: string;
  client: Pick<APIMasterClient, "resolveAPIKey">;
  logger: Pick<Logger, "info" | "warn">;
}

// This monitor cannot send Telegram messages or submit media: the smoke runner owns no Telegram API or tools.
export class AgentLoopMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private consecutiveFailures = 0;
  private lastSuccessAt: number | null = null;

  constructor(private readonly options: AgentLoopMonitorOptions) {}

  start(): void {
    if (!this.options.enabled || !this.options.userId || this.timer) return;
    this.timer = setInterval(() => void this.run(), this.options.intervalMs);
    this.timer.unref();
    void this.run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async run(): Promise<void> {
    if (!this.options.enabled || !this.options.userId || this.running) return;
    this.running = true;
    try {
      const report = await runAgentLoopSmoke({
        client: this.options.client,
        baseUrl: this.options.baseUrl,
        userId: this.options.userId,
        model: this.options.model,
        timeoutMs: this.options.timeoutMs,
        logger: this.options.logger,
      });
      if (report.status === "passed") {
        this.consecutiveFailures = 0;
        this.lastSuccessAt = Date.now();
        this.options.logger.info({ model: this.options.model, durationMs: report.durationMs, lastSuccessAt: this.lastSuccessAt }, "Mia Agent Loop monitor passed");
      } else {
        this.consecutiveFailures += 1;
        const errors = report.scenarios.filter((scenario) => scenario.status === "failed").map((scenario) => ({ scenario: scenario.scenario, layer: scenario.layer, error: scenario.error }));
        const log = this.consecutiveFailures >= this.options.failureThreshold ? this.options.logger.warn : this.options.logger.info;
        log({ model: this.options.model, consecutiveFailures: this.consecutiveFailures, threshold: this.options.failureThreshold, lastSuccessAt: this.lastSuccessAt, errors }, "Mia Agent Loop monitor failed");
      }
    } catch (error) {
      this.consecutiveFailures += 1;
      const log = this.consecutiveFailures >= this.options.failureThreshold ? this.options.logger.warn : this.options.logger.info;
      log({ error: error instanceof Error ? error.message : "unknown", consecutiveFailures: this.consecutiveFailures, lastSuccessAt: this.lastSuccessAt }, "Mia Agent Loop monitor could not run");
    } finally {
      this.running = false;
    }
  }
}
