import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import { EXCLUSIVE_RUNNER, type ExclusiveRunner } from "../../application/ports/exclusive-runner";
import { LOGGER, type Logger } from "../../application/ports/logger";
import { PurgeMessagingTables, type PurgeResult } from "../../application/messaging/purge-messaging-tables";
import { APP_CONFIG, type AppConfig } from "../../config/config";

export const RETENTION_LOCK = "retention";

export type RetentionOutcome = ({ status: "completed" } & PurgeResult) | { status: "skipped" };

/**
 * Loop de retenção de outbox e inbox. Liga só com o papel `retention`. Cada ciclo pega o advisory lock
 * `retention` numa conexão dedicada; quem não pega pula o ciclo.
 */
@Injectable()
export class RetentionWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private running = false;
  private stopping = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(EXCLUSIVE_RUNNER) private readonly exclusive: ExclusiveRunner,
    private readonly job: PurgeMessagingTables,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.roles.has("retention")) return;
    this.running = true;
    this.schedule();
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Um ciclo. Lança o erro do job (o lock já foi liberado); o loop captura e loga. */
  async runOnce(): Promise<RetentionOutcome> {
    const { outboxHours, inboxHours } = this.config.retention;
    const res = await this.exclusive.runExclusive(RETENTION_LOCK, () =>
      this.job.run({ outboxRetentionHours: outboxHours, inboxRetentionHours: inboxHours }, undefined, () => this.stopping),
    );
    if (!res.acquired) {
      this.logger.info({}, "retention skipped: another instance holds the lock");
      return { status: "skipped" };
    }
    return { status: "completed", ...res.value };
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
    this.running = false;
  }

  private schedule(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.cycle().finally(() => {
        this.inFlight = undefined;
        this.schedule();
      });
    }, this.config.retention.intervalMs);
  }

  private async cycle(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      const e = err instanceof Error ? err : undefined;
      this.logger.error({ errorName: e?.name ?? "UnknownError", stack: e?.stack }, "retention cycle failed");
    }
  }
}
