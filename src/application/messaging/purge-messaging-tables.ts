import type { Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { TransactionScope, UnitOfWork } from "../ports/unit-of-work";

export const MIN_INBOX_RETENTION_HOURS = 24;
const HOUR_MS = 3_600_000;
const DEFAULT_BATCH = 1000;

export interface RetentionPolicy {
  outboxRetentionHours: number;
  inboxRetentionHours: number;
}

export interface PurgeResult {
  outbox: number;
  inbox: number;
}

/**
 * Apaga, em lotes (uma transação curta por lote), outbox publicada e inbox mais velhas que a retenção.
 * Outbox não publicada nunca é apagada (o repositório só alcança `published_at` não nulo). A inbox tem
 * mínimo de 24 h: ela é o que impede a dupla aplicação de uma mensagem que o SQS ainda pode reentregar.
 */
export class PurgeMessagingTables {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async run(
    policy: RetentionPolicy,
    batchSize: number = DEFAULT_BATCH,
    shouldStop: () => boolean = () => false,
  ): Promise<PurgeResult> {
    if (policy.inboxRetentionHours < MIN_INBOX_RETENTION_HOURS) {
      throw new Error(`inbox retention must be at least ${MIN_INBOX_RETENTION_HOURS} hours`);
    }
    const now = this.clock.now().getTime();
    const outboxCutoff = new Date(now - policy.outboxRetentionHours * HOUR_MS);
    const inboxCutoff = new Date(now - policy.inboxRetentionHours * HOUR_MS);

    const outbox = await this.drain((s) => s.outbox.purgePublishedBefore(outboxCutoff, batchSize), batchSize, shouldStop);
    const inbox = await this.drain((s) => s.inbox.purgeProcessedBefore(inboxCutoff, batchSize), batchSize, shouldStop);
    this.logger.info({ outbox, inbox }, "retention run finished");
    return { outbox, inbox };
  }

  private async drain(
    purge: (scope: TransactionScope) => Promise<number>,
    batchSize: number,
    shouldStop: () => boolean,
  ): Promise<number> {
    let total = 0;
    while (!shouldStop()) {
      const n = await this.uow.run(purge);
      total += n;
      if (n < batchSize) break;
    }
    return total;
  }
}
