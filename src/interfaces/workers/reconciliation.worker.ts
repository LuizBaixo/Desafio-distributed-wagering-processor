import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import { EXCLUSIVE_RUNNER, type ExclusiveRunner } from "../../application/ports/exclusive-runner";
import { LOGGER, type Logger } from "../../application/ports/logger";
import { ReconcileAllWallets, type ReconcileAllResult } from "../../application/wallet/reconcile-all-wallets";
import { APP_CONFIG, type AppConfig } from "../../config/config";

export const RECONCILIATION_LOCK = "reconciliation";

export type ReconciliationOutcome = ({ status: "completed" } & ReconcileAllResult) | { status: "skipped" };

/**
 * Loop do job de reconciliação. Liga só com o papel `reconciler`. Cada ciclo pega o advisory lock
 * `reconciliation` numa conexão dedicada: quem não pega pula o ciclo, então só uma instância roda por vez.
 */
@Injectable()
export class ReconciliationWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private running = false;
  private stopping = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(EXCLUSIVE_RUNNER) private readonly exclusive: ExclusiveRunner,
    private readonly job: ReconcileAllWallets,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.roles.has("reconciler")) return;
    this.running = true;
    this.schedule();
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Um ciclo. Lança o erro do job (o lock já foi liberado); o loop captura e loga. */
  async runOnce(): Promise<ReconciliationOutcome> {
    const res = await this.exclusive.runExclusive(RECONCILIATION_LOCK, () => this.job.run(() => this.stopping));
    if (!res.acquired) {
      this.logger.info({}, "reconciliation skipped: another instance holds the lock");
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
    }, this.config.reconciliation.intervalMs);
  }

  private async cycle(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      const e = err instanceof Error ? err : undefined;
      this.logger.error({ errorName: e?.name ?? "UnknownError", stack: e?.stack }, "reconciliation cycle failed");
    }
  }
}
