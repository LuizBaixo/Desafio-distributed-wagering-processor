import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { z } from "zod";
import { ConcurrencyViolationError, InvalidPayloadError, TransientInfrastructureError } from "../../application/errors";
import type { Logger } from "../../application/ports/logger";
import { LOGGER } from "../../application/ports/logger";
import type { Metrics } from "../../application/ports/metrics";
import { QUEUE_PORT, type QueueMessage, type QueuePort } from "../../application/ports/queue";
import { METRICS } from "../../application/ports/tokens";
import { wagerPayloadHash } from "../../application/idempotency/payload-hash";
import { RecordPermanentFailure } from "../../application/wagering/record-permanent-failure";
import { SubmitWagerTransaction } from "../../application/wagering/submit-wager-transaction";
import { parseWagerCommand, type WagerCommand } from "../../application/wagering/wager-command";
import { APP_CONFIG, type AppConfig } from "../../config/config";
import { InvalidMoneyError } from "../../domain/shared/domain-error";
import { runWithContext } from "../../infrastructure/observability/correlation";
import { FAULT_INJECTION, type FaultInjection } from "../../infrastructure/system/fault-injection";

export const CONSUMER_NAME = "wager-transactions-consumer";

/** Corpo que não é JSON. Tratado como payload inválido (permanente). */
class MalformedJsonError extends Error {
  readonly code = "MALFORMED_JSON";
  constructor() {
    super("message body is not valid JSON");
    this.name = "MalformedJsonError";
  }
}

/** Envelope do README §10. */
const envelopeSchema = z.object({
  messageId: z.string().min(1).max(128),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});

interface ParsedMessage {
  messageId: string;
  cmd: WagerCommand;
}

function defaultIdempotencyKey(data: Record<string, unknown>): string | undefined {
  const { providerId, externalTransactionId } = data;
  if (typeof providerId !== "string" || typeof externalTransactionId !== "string") return undefined;
  if (providerId.length === 0 || externalTransactionId.length === 0) return undefined;
  return `${providerId}:${externalTransactionId}`;
}

function parseMessage(body: string): ParsedMessage {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new MalformedJsonError();
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) {
    const details = envelope.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new InvalidPayloadError(`invalid envelope: ${details}`);
  }
  // A idempotencyKey viaja dentro de `data` na fila; o parser do comando a recebe à parte (como o header HTTP).
  const { idempotencyKey, ...rest } = envelope.data.data;
  // Sem chave na mensagem, vale o padrão recomendado pelo desafio: {providerId}:{externalTransactionId}.
  const key = typeof idempotencyKey === "string" ? idempotencyKey : defaultIdempotencyKey(rest);
  return { messageId: envelope.data.messageId, cmd: parseWagerCommand(rest, key) };
}

/** Melhor esforço para achar o walletId e usá-lo como grupo FIFO da DLQ. */
function groupIdOf(body: string): string {
  try {
    const walletId = (JSON.parse(body) as { data?: { walletId?: unknown } }).data?.walletId;
    if (typeof walletId === "string" && walletId.length > 0 && walletId.length <= 128) return walletId;
  } catch {
    // corpo ilegível
  }
  return "unparseable";
}

function permanentReason(e: unknown): string {
  if (e instanceof MalformedJsonError) return e.code;
  if (e instanceof InvalidPayloadError) return e.code;
  if (e instanceof InvalidMoneyError) return e.code;
  return "INFRA_PERMANENT";
}

function isTransient(e: unknown): boolean {
  return e instanceof TransientInfrastructureError || e instanceof ConcurrencyViolationError;
}

/**
 * Consumidor da fila de apostas. Liga só com o papel `consumer`.
 *
 * Garantias: o ack (delete) só acontece depois de `execute` resolver, isto é, depois do commit
 * (a inbox está na mesma transação); uma mensagem entregue duas vezes cai na inbox e vira no-op.
 */
@Injectable()
export class WagerConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private loop: Promise<void> | undefined;
  private readonly inFlight = new Map<Promise<void>, QueueMessage>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(FAULT_INJECTION) private readonly fault: FaultInjection,
    private readonly submit: SubmitWagerTransaction,
    private readonly recordFailure: RecordPermanentFailure,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.roles.has("consumer")) return;
    this.running = true;
    this.loop = this.run();
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Para o receive, espera as mensagens em andamento por até SHUTDOWN_GRACE_MS e devolve as que
   * não terminaram com ChangeMessageVisibility 0, para outra instância pegá-las já.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    // Não aborta o long poll: um receive abortado no cliente pode ainda ser atendido no servidor e
    // deixaria a mensagem invisível até o visibility timeout. Esperamos o receive atual terminar
    // (no máximo CONSUMER_WAIT_SECONDS) e devolvemos o que ele trouxer.
    await this.loop;

    const pending = [...this.inFlight.keys()];
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.config.consumer.shutdownGraceMs);
    });
    const outcome = await Promise.race([Promise.allSettled(pending).then(() => "done" as const), grace]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === "done") return;

    await Promise.allSettled(
      [...this.inFlight.values()].map((m) =>
        this.queue.changeVisibility(this.config.queues.wager, m.receiptHandle, 0).catch((e: unknown) => this.logFailure(e, "release on shutdown failed")),
      ),
    );
  }

  private async run(): Promise<void> {
    const { concurrency, waitSeconds } = this.config.consumer;
    while (this.running) {
      const free = concurrency - this.inFlight.size;
      if (free <= 0) {
        await Promise.race(this.inFlight.keys());
        continue;
      }
      let messages: QueueMessage[];
      try {
        messages = await this.queue.receive(this.config.queues.wager, Math.min(10, free), waitSeconds);
      } catch (e) {
        this.logFailure(e, "receive failed");
        if (this.running) await sleep(1000);
        continue;
      }
      if (!this.running) {
        // Parou durante o receive: nada foi iniciado, devolve tudo para outra instância pegar já.
        await Promise.allSettled(
          messages.map((m) => this.queue.changeVisibility(this.config.queues.wager, m.receiptHandle, 0)),
        );
        break;
      }
      for (const m of messages) {
        const task: Promise<void> = this.handle(m).finally(() => this.inFlight.delete(task));
        this.inFlight.set(task, m);
      }
    }
  }

  /** Nunca lança: qualquer falha vira log, e a mensagem reaparece pela visibilidade. */
  private async handle(m: QueueMessage): Promise<void> {
    try {
      await runWithContext({ correlationId: m.messageId, messageId: m.messageId }, () => this.process(m));
    } catch (e) {
      this.logFailure(e, "unexpected failure handling message");
    }
  }

  private async process(m: QueueMessage): Promise<void> {
    const queueName = this.config.queues.wager;

    let parsed: ParsedMessage;
    try {
      parsed = parseMessage(m.body);
    } catch (e) {
      await this.deadLetter(m, permanentReason(e));
      return;
    }
    const { messageId, cmd } = parsed;

    await runWithContext(
      { correlationId: messageId, messageId, walletId: cmd.walletId, providerId: cmd.providerId },
      async () => {
        await this.testSlowdown();
        try {
          await this.submit.execute(cmd, {
            correlationId: messageId,
            causationId: messageId,
            inbox: { consumerName: CONSUMER_NAME, messageId, payloadHash: wagerPayloadHash(cmd) },
          });
        } catch (e) {
          await this.onFailure(m, e, parsed);
          return;
        }
        // Commit feito. Qualquer saída do processo a partir daqui é "crash entre commit e ack".
        this.fault.afterCommit();
        await this.ack(queueName, m);
      },
    );
  }

  private async onFailure(m: QueueMessage, e: unknown, parsed: ParsedMessage): Promise<void> {
    if (isTransient(e)) {
      await this.retryLater(m);
      return;
    }
    if (!(e instanceof InvalidPayloadError) && !(e instanceof InvalidMoneyError)) {
      this.logFailure(e, "permanent failure, sending to DLQ");
      await this.recordFailed(parsed);
    }
    await this.deadLetter(m, permanentReason(e));
  }

  /** Grava FAILED antes da DLQ. Se falhar, só loga: a mensagem na DLQ continua sendo o registro. */
  private async recordFailed(parsed: ParsedMessage): Promise<void> {
    try {
      await this.recordFailure.execute(parsed.cmd, {
        correlationId: parsed.messageId,
        causationId: parsed.messageId,
        messageId: parsed.messageId,
        consumerName: CONSUMER_NAME,
      });
    } catch (err) {
      this.logFailure(err, "recording FAILED transaction failed");
    }
  }

  /** Sem ack. O backoff é 2^receiveCount segundos, com teto; depois de 5 recebimentos o redrive do SQS age. */
  private async retryLater(m: QueueMessage): Promise<void> {
    const delay = Math.min(2 ** m.receiveCount, this.config.consumer.maxBackoffSeconds);
    this.metrics.retry("consumer");
    try {
      await this.queue.changeVisibility(this.config.queues.wager, m.receiptHandle, delay);
    } catch (e) {
      this.logFailure(e, "changeVisibility failed");
    }
  }

  /** Copia para a DLQ com o motivo e só então apaga da fila principal. Se a cópia falhar, vira retry. */
  private async deadLetter(m: QueueMessage, reason: string): Promise<void> {
    try {
      await this.queue.send(this.config.queues.wagerDlq, m.body, {
        groupId: groupIdOf(m.body),
        dedupId: m.messageId,
        attributes: { reason },
      });
    } catch (e) {
      this.logFailure(e, "send to DLQ failed");
      await this.retryLater(m);
      return;
    }
    this.metrics.dlq();
    await this.ack(this.config.queues.wager, m);
  }

  private async ack(queueName: string, m: QueueMessage): Promise<void> {
    try {
      await this.queue.delete(queueName, m.receiptHandle);
    } catch (e) {
      // A mensagem volta, cai na inbox e vira no-op: seguro.
      this.logFailure(e, "delete failed");
    }
  }

  /** Gancho de teste: deixa a mensagem "em andamento" por TEST_SLOW_MS. Inativo fora de NODE_ENV=test. */
  private async testSlowdown(): Promise<void> {
    if (process.env.NODE_ENV !== "test") return;
    const ms = Number(process.env.TEST_SLOW_MS ?? 0);
    if (Number.isFinite(ms) && ms > 0) await sleep(ms);
  }

  private logFailure(e: unknown, msg: string): void {
    const err = e instanceof Error ? e : undefined;
    this.logger.error({ errorName: err?.name ?? "UnknownError", stack: err?.stack }, msg);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
