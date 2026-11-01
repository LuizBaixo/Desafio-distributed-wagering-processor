import type { WagerTransactionRepository } from "../../../application/ports/repositories";
import type { WagerTransaction } from "../../../domain/wagering/wager-transaction";
import { transactionFromRow } from "../mappers";
import type { WagerTransactionRow } from "../schemas";
import type { Db } from "../sql";

export class PgWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly db: Db) {}

  async insert(tx: WagerTransaction): Promise<void> {
    await this.db.run(
      `INSERT INTO wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
          round_id, game_id, kind, amount, currency, reference_external_transaction_id,
          reference_transaction_id, status, failure_code, result_balance, result_currency,
          attempts, next_attempt_at, created_at, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.amount,
        tx.money.currency,
        tx.referenceExternalTransactionId ?? null,
        tx.referenceTransactionId ?? null,
        tx.status,
        tx.failureCode ?? null,
        tx.resultBalance?.amount ?? null,
        tx.resultBalance?.currency ?? null,
        tx.attempts,
        tx.nextAttemptAt ?? null,
        tx.createdAt,
        tx.processedAt ?? null,
      ],
    );
  }

  async update(tx: WagerTransaction): Promise<void> {
    await this.db.run(
      `UPDATE wager_transactions
          SET status = ?, reference_transaction_id = ?, failure_code = ?, result_balance = ?,
              result_currency = ?, attempts = ?, next_attempt_at = ?, processed_at = ?
        WHERE id = ?`,
      [
        tx.status,
        tx.referenceTransactionId ?? null,
        tx.failureCode ?? null,
        tx.resultBalance?.amount ?? null,
        tx.resultBalance?.currency ?? null,
        tx.attempts,
        tx.nextAttemptAt ?? null,
        tx.processedAt ?? null,
        tx.id,
      ],
    );
  }

  findById(id: string): Promise<WagerTransaction | null> {
    return this.selectOne("id = ?", [id], "");
  }

  lockById(id: string): Promise<WagerTransaction | null> {
    return this.selectOne("id = ?", [id], " FOR UPDATE");
  }

  findByIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | null> {
    return this.selectOne("provider_id = ? AND idempotency_key = ?", [providerId, key], "");
  }

  findByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null> {
    return this.selectOne("provider_id = ? AND external_transaction_id = ?", [providerId, externalId], "");
  }

  async isReversed(referenceTransactionId: string): Promise<boolean> {
    const row = await this.db.one(
      `SELECT 1 AS found FROM wager_transactions
        WHERE reference_transaction_id = ? AND kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'
        LIMIT 1`,
      [referenceTransactionId],
    );
    return row !== null;
  }

  markDependentsDue(providerId: string, externalId: string, now: Date): Promise<number> {
    return this.db.run(
      `UPDATE wager_transactions SET next_attempt_at = ?
        WHERE provider_id = ? AND reference_external_transaction_id = ? AND status = 'PENDING_REFERENCE'`,
      [now, providerId, externalId],
    );
  }

  async claimDuePending(
    limit: number,
    leaseSeconds: number,
    now: Date,
  ): Promise<Array<{ id: string; walletId: string }>> {
    const rows = await this.db.rows<{ id: string; wallet_id: string }>(
      `UPDATE wager_transactions
          SET next_attempt_at = ?::timestamptz + make_interval(secs => ?)
        WHERE id IN (
          SELECT id FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= ?
           ORDER BY next_attempt_at
           FOR UPDATE SKIP LOCKED
           LIMIT ?)
       RETURNING id, wallet_id`,
      [now, leaseSeconds, now, limit],
    );
    return rows.map((r) => ({ id: r.id, walletId: r.wallet_id }));
  }

  private async selectOne(where: string, params: unknown[], lock: string): Promise<WagerTransaction | null> {
    const row = await this.db.one<WagerTransactionRow>(
      `SELECT * FROM wager_transactions WHERE ${where}${lock}`,
      params,
    );
    return row ? transactionFromRow(row) : null;
  }
}
