import type { BeforeApplicationShutdown, OnApplicationBootstrap } from "@nestjs/common";
import type { Clock } from "../../application/ports/clock";
import type { Logger } from "../../application/ports/logger";
import type { Metrics } from "../../application/ports/metrics";
import type { QueuePort } from "../../application/ports/queue";
import type { UnitOfWork } from "../../application/ports/unit-of-work";

export interface OutboxPublisherOptions {
  /** Fila de destino (`wallet-events.fifo`). */
  queueName: string;
  /** Intervalo do loop (OUTBOX_POLL_MS). */
  pollMs: number;
  /** Só liga o loop com o papel `outbox` em APP_ROLES. */
  enabled: boolean;
  /** Tamanho do lote por claim (Design §14: 50). */
  batchSize?: number;
  /** Lease padrão do claim (Design §14: 30 s). `tick({ leaseSeconds })` sobrescreve. */
  leaseSeconds?: number;
}

const DEFAULT_BATCH = 50;
const DEFAULT_LEASE_SECONDS = 30;

/**
 * Publica a outbox na fila de eventos (Design §14).
 *
 * Cada `tick`: claim do lote com lease (transação curta), depois send de cada mensagem seguido de
 * markPublished. Falha de send: `scheduleRetry` + `release`, métrica `retry('outbox')`, e o lote segue.
 * Crash entre send e markPublished: o lease expira e outra instância republica (at-least-once);
 * o MessageDeduplicationId = eventId e o consumidor deduplicam.
 */
export class OutboxPublisher implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private running = false;
  private stopping = false;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly queue: QueuePort,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly options: OutboxPublisherOptions,
  ) {}

  /** Um ciclo. Devolve o número de eventos publicados (com published_at gravado). */
  async tick(opts: { leaseSeconds?: number; shouldStop?: () => boolean } = {}): Promise<number> {
    const now = this.clock.now();
    const lease = opts.leaseSeconds ?? this.options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    const shouldStop = opts.shouldStop ?? (() => false);

    const batch = await this.uow.run((scope) =>
      scope.outbox.claimDue(this.options.batchSize ?? DEFAULT_BATCH, lease, now),
    );

    let published = 0;
    for (const msg of batch) {
      if (shouldStop()) break;

      try {
        await this.queue.send(this.options.queueName, JSON.stringify(msg.payload), {
          groupId: msg.aggregateId,
          dedupId: msg.id,
        });
      } catch (err) {
        // Falha de envio: agenda nova tentativa e segue para a próxima mensagem do lote.
        msg.scheduleRetry(now);
        try {
          await this.uow.run((scope) => scope.outbox.release(msg));
        } catch (releaseErr) {
          this.logger.error({ outboxId: msg.id, errorName: errorName(releaseErr) }, "outbox release failed");
        }
        this.metrics.retry("outbox");
        this.logger.error({ outboxId: msg.id, errorName: errorName(err) }, "outbox publish failed");
        continue;
      }

      try {
        await this.uow.run((scope) => scope.outbox.markPublished(msg.id, this.clock.now()));
        published++;
      } catch (err) {
        // Enviado mas não marcado: o lease expira e a mensagem é republicada (at-least-once).
        this.logger.error({ outboxId: msg.id, errorName: errorName(err) }, "outbox mark failed");
      }
    }

    const lag = await this.uow.run((scope) => scope.outbox.oldestPendingAgeSeconds(this.clock.now()));
    this.metrics.setOutboxLag(lag);
    return published;
  }

  onApplicationBootstrap(): void {
    if (!this.options.enabled) return;
    this.running = true;
    this.schedule();
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Para o loop e espera o ciclo em andamento. O ORM só fecha depois (onApplicationShutdown). */
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
    }, this.options.pollMs);
  }

  private async cycle(): Promise<void> {
    try {
      await this.tick({ shouldStop: () => this.stopping });
    } catch (err) {
      this.logger.error({ errorName: errorName(err) }, "outbox publisher cycle failed");
    }
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
