import type { IntegrationEvent } from "../events/integration-event";

const MAX_BACKOFF_SECONDS = 300;

/** Mensagem de integração pendente de publicação. Gravada na mesma transação do fato de negócio. */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
    private _deadAt?: Date,
    private _lastError?: string,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Readonly<Record<string, unknown>>,
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
      undefined,
      undefined,
    );
  }

  /** Reconstrói estado persistido; não revalida. */
  static rehydrate(state: {
    id: string;
    aggregateId: string;
    eventType: string;
    payload: Readonly<Record<string, unknown>>;
    occurredAt: Date;
    attempts: number;
    nextAttemptAt?: Date;
    publishedAt?: Date;
    deadAt?: Date;
    lastError?: string;
  }): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.deadAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  /** Quando a mensagem foi dada como morta (falha permanente ou tentativas esgotadas). */
  get deadAt(): Date | undefined {
    return this._deadAt;
  }

  /** Último código de erro de publicação, gravado junto com `dead_at`. */
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined && this._deadAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt !== undefined && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
  }

  /** Dá a mensagem como morta: sai do claim e do lag e fica na tabela para inspeção. */
  markDead(at: Date, lastError: string): void {
    this._deadAt = at;
    this._lastError = lastError;
  }

  /** Backoff: min(2^attempts, 300) s, calculado antes de incrementar attempts. */
  scheduleRetry(now: Date): void {
    const delaySeconds = Math.min(2 ** this._attempts, MAX_BACKOFF_SECONDS);
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000);
  }
}
