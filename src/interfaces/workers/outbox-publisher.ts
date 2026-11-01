import type { BeforeApplicationShutdown, OnApplicationBootstrap } from "@nestjs/common";
import type { Clock } from "../../application/ports/clock";
import type { Logger } from "../../application/ports/logger";
import type { Metrics } from "../../application/ports/metrics";
import type { BatchEntry, BatchResult, QueuePort } from "../../application/ports/queue";
import type { UnitOfWork } from "../../application/ports/unit-of-work";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export interface OutboxPublisherOptions {
  /** Fila de destino (`wallet-events.fifo`). */
  queueName: string;
  /** Intervalo do loop (OUTBOX_POLL_MS). */
  pollMs: number;
  /** Só liga o loop com o papel `outbox` em APP_ROLES. */
  enabled: boolean;
  /** Tamanho do claim (OUTBOX_BATCH_SIZE). */
  batchSize?: number;
  /** Entradas por `SendMessageBatch` (OUTBOX_SEND_BATCH, no máximo 10). */
  sendBatchSize?: number;
  /** Lease padrão do claim (Design §14: 30 s). `tick({ leaseSeconds })` sobrescreve. */
  leaseSeconds?: number;
}

const DEFAULT_BATCH = 100;
const DEFAULT_SEND_BATCH = 10;
const MAX_SEND_BATCH = 10;
const DEFAULT_LEASE_SECONDS = 30;

/**
 * Publica a outbox na fila de eventos (Design §14).
 *
 * Cada `tick`: claim com lease (transação curta), divisão em lotes de até 10 e, por lote, um
 * `SendMessageBatch` seguido de uma única transação com `markPublishedMany` (enviados) e `release`
 * (falhos). Falha de entrada: `scheduleRetry` + `release`, métrica `retry('outbox')`, e os outros lotes
 * seguem. Crash entre send e mark: o lease expira e outra instância republica (at-least-once);
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

    const sendSize = Math.min(this.options.sendBatchSize ?? DEFAULT_SEND_BATCH, MAX_SEND_BATCH);
    let published = 0;
    let failed = 0;
    for (let from = 0; from < batch.length; from += sendSize) {
      if (shouldStop()) break;
      const chunk = batch.slice(from, from + sendSize);
      const result = await this.publishChunk(chunk, now);
      published += result.published;
      failed += result.failed;
    }

    if (batch.length > 0) {
      this.logger.info({ claimed: batch.length, published, failed }, "outbox batch published");
    }

    const lag = await this.uow.run((scope) => scope.outbox.oldestPendingAgeSeconds(this.clock.now()));
    this.metrics.setOutboxLag(lag);
    return published;
  }

  /**
   * Envia um lote (no máximo 10) e fecha o resultado em uma única transação: `markPublishedMany` nos
   * enviados e `release` nos que falharam. Só o que o SQS confirmou é marcado como publicado.
   */
  private async publishChunk(chunk: OutboxMessage[], now: Date): Promise<{ published: number; failed: number }> {
    const entries: BatchEntry[] = chunk.map((msg) => ({
      id: msg.id,
      body: JSON.stringify(msg.payload),
      groupId: msg.aggregateId,
      dedupId: msg.id,
    }));

    let result: BatchResult;
    try {
      result = await this.queue.sendBatch(this.options.queueName, entries);
    } catch (err) {
      // Chamada inteira falhou: nenhuma entrada foi confirmada.
      this.logger.error({ batchSize: chunk.length, errorName: errorName(err) }, "outbox publish failed");
      result = { ok: [], failed: chunk.map((m) => ({ id: m.id, code: errorName(err) })) };
    }

    const okIds = new Set(result.ok);
    const sent = chunk.filter((m) => okIds.has(m.id));
    // Qualquer entrada que o SQS não confirmou volta para retry, inclusive as que ele omitiu.
    const retry = chunk.filter((m) => !okIds.has(m.id));
    for (const msg of retry) msg.scheduleRetry(now);
    for (const f of result.failed) {
      this.logger.error({ outboxId: f.id, code: f.code }, "outbox publish failed");
    }

    try {
      await this.uow.run(async (scope) => {
        if (sent.length > 0) {
          await scope.outbox.markPublishedMany(
            sent.map((m) => m.id),
            this.clock.now(),
          );
        }
        for (const msg of retry) await scope.outbox.release(msg);
      });
    } catch (err) {
      // Enviado mas não marcado (ou retry não gravado): o lease expira e a mensagem é reprocessada (at-least-once).
      this.logger.error({ batchSize: chunk.length, errorName: errorName(err) }, "outbox mark failed");
      return { published: 0, failed: retry.length };
    }

    for (let i = 0; i < retry.length; i++) this.metrics.retry("outbox");
    return { published: sent.length, failed: retry.length };
  }

  onApplicationBootstrap(): void {
    if (!this.options.enabled) return;
    this.running = true;
    // Primeiro ciclo imediato: drena um backlog existente sem esperar pollMs.
    this.schedule(0);
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

  private schedule(delayMs: number = this.options.pollMs): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.cycle().then((published) => {
        this.inFlight = undefined;
        // Lote cheio indica backlog: o próximo ciclo sai já. Lote parcial ou vazio espera pollMs.
        this.schedule(published >= (this.options.batchSize ?? DEFAULT_BATCH) ? 0 : this.options.pollMs);
      });
    }, delayMs);
  }

  /** Nunca rejeita: falha do tick vira log e conta como zero publicados. */
  private async cycle(): Promise<number> {
    try {
      return await this.tick({ shouldStop: () => this.stopping });
    } catch (err) {
      this.logger.error({ errorName: errorName(err) }, "outbox publisher cycle failed");
      return 0;
    }
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
