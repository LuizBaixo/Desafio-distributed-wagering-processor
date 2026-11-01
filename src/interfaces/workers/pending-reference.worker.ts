import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import { ReprocessPendingReferences } from "../../application/wagering/reprocess-pending-references";
import { LOGGER, type Logger } from "../../application/ports/logger";
import { APP_CONFIG, type AppConfig } from "../../config/config";

/**
 * Loop de polling do worker de pendentes. Liga só com o papel `pending` (APP_ROLES).
 * Nos testes o papel não está presente: o loop não liga, e os testes chamam `tick()` direto.
 * No shutdown, o loop para depois do item em andamento (o `tick` checa `stopping` entre itens).
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private running = false;
  private stopping = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly reprocess: ReprocessPendingReferences,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.roles.has("pending")) return;
    this.running = true;
    this.schedule();
  }

  isRunning(): boolean {
    return this.running;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    // Espera o ciclo em andamento: ele termina o item atual e para.
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
    }, this.config.pending.pollMs);
  }

  private async cycle(): Promise<void> {
    try {
      await this.reprocess.tick(() => this.stopping);
    } catch (err) {
      const e = err instanceof Error ? err : undefined;
      this.logger.error({ errorName: e?.name ?? "UnknownError", stack: e?.stack }, "pending reference cycle failed");
    }
  }
}
