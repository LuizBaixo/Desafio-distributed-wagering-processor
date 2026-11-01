import type { BeforeApplicationShutdown, OnApplicationBootstrap } from "@nestjs/common";
import type { Clock } from "../../application/ports/clock";
import type { Logger } from "../../application/ports/logger";
import type { Metrics } from "../../application/ports/metrics";
import type { BatchEntry, BatchResult, QueuePort } from "../../application/ports/queue";
import { getTracing } from "../../application/ports/tracing";
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
  /** Tentativas até a mensagem ser dada como morta (OUTBOX_MAX_ATTEMPTS). */
  maxAttempts?: number;
  /** Lease padrão do claim (Design §14: 30 s). `tick({ leaseSeconds })` sobrescreve. */
  leaseSeconds?: number;
}

const DEFAULT_BATCH = 100;
const DEFAULT_SEND_BATCH = 10;
const MAX_SEND_BATCH = 10;
const DEFAULT_LEASE_SECONDS = 30;
const DEFAULT_MAX_ATTEMPTS = 50;
/**
 * Códigos de falha por entrada que repetir o envio não resolve: o conteúdo ou o pedido está errado (falha do
 * remetente, na documentação do SQS). `BODY_TOO_LARGE` é o código local de corpo acima de 256 KiB.
 */
const PERMANENT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "BODY_TOO_LARGE",
  "InvalidParameterValue",
  "InvalidMessageContents",
  "UnsupportedOperation",
  "MissingParameter",
  "InvalidAttributeName",
  "InvalidAttributeValue",
]);
/** Limite do SQS para a soma dos corpos de um `SendMessageBatch` (e para um corpo isolado). */
const MAX_BATCH_BYTES = 262_144;

interface PreparedMessage {
  msg: OutboxMessage;
  body: string;
  bytes: number;
}

/**
 * Divide em lotes de no máximo `maxEntries` entradas e `MAX_BATCH_BYTES` bytes somados (UTF-8).
 * Uma entrada que sozinha passa do limite fica num lote só dela; o SQS a recusa como `BODY_TOO_LARGE`.
 */
function planChunks(items: PreparedMessage[], maxEntries: number): PreparedMessage[][] {
  const chunks: PreparedMessage[][] = [];
  let current: PreparedMessage[] = [];
  let currentBytes = 0;
  for (const item of items) {
    const oversize = item.bytes > MAX_BATCH_BYTES;
    const overflows = current.length >= maxEntries || currentBytes + item.bytes > MAX_BATCH_BYTES;
    if (current.length > 0 && (oversize || overflows)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += item.bytes;
    if (oversize) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Publica a outbox na fila de eventos (Design §14).
 *
 * Cada `tick`: claim com lease (transação curta), divisão em lotes de até 10 entradas e 256 KiB e, por lote, um
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
    const prepared: PreparedMessage[] = batch.map((msg) => {
      const body = JSON.stringify(msg.payload);
      return { msg, body, bytes: Buffer.byteLength(body, "utf8") };
    });
    for (const chunk of planChunks(prepared, sendSize)) {
      if (shouldStop()) break;
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
  private publishChunk(chunk: PreparedMessage[], now: Date): Promise<{ published: number; failed: number }> {
    return getTracing().withSpan("outbox.publish_batch", { "messaging.batch.size": chunk.length }, async (span) => {
      const r = await this.publishChunkInner(chunk, now);
      span.setAttribute("outbox.published", r.published);
      span.setAttribute("outbox.failed", r.failed);
      return r;
    });
  }

  private async publishChunkInner(prepared: PreparedMessage[], now: Date): Promise<{ published: number; failed: number }> {
    // O `traceparent` vai como atributo da mensagem; o payload do evento fica intocado.
    const traceparent = getTracing().currentTraceparent();
    const chunk = prepared.map((p) => p.msg);
    const entries: BatchEntry[] = prepared.map(({ msg, body }) => ({
      id: msg.id,
      body,
      groupId: msg.aggregateId,
      dedupId: msg.id,
      ...(traceparent !== undefined ? { attributes: { traceparent } } : {}),
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
    const codes = new Map(result.failed.map((f) => [f.id, f.code]));
    const maxAttempts = this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    // Falha permanente, ou tentativas esgotadas: a mensagem morre (dead_at) em vez de voltar para a fila de retry.
    const dead: OutboxMessage[] = [];
    const retrying: OutboxMessage[] = [];
    for (const msg of retry) {
      const code = codes.get(msg.id) ?? "OmittedFromResult";
      if (PERMANENT_FAILURE_CODES.has(code)) {
        msg.markDead(this.clock.now(), code);
        dead.push(msg);
        continue;
      }
      msg.scheduleRetry(now);
      if (msg.attempts >= maxAttempts) {
        msg.markDead(this.clock.now(), code);
        dead.push(msg);
      } else {
        retrying.push(msg);
      }
    }
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
        for (const msg of retrying) await scope.outbox.release(msg);
        for (const msg of dead) await scope.outbox.markDead(msg);
      });
    } catch (err) {
      // Enviado mas não marcado (ou retry não gravado): o lease expira e a mensagem é reprocessada (at-least-once).
      this.logger.error({ batchSize: chunk.length, errorName: errorName(err) }, "outbox mark failed");
      return { published: 0, failed: retry.length };
    }

    for (const msg of dead) {
      this.logger.error(
        { outboxId: msg.id, eventType: msg.eventType, attempts: msg.attempts, lastError: msg.lastError },
        "outbox message dead",
      );
      this.metrics.outboxDead();
    }
    for (let i = 0; i < retrying.length; i++) this.metrics.retry("outbox");
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
