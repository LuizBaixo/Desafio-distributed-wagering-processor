import { NotFoundError } from "../../../application/errors";
import type { LedgerRepository } from "../../../application/ports/repositories";
import type { WalletLedgerEntry } from "../../../domain/ledger/wallet-ledger-entry";
import { Money } from "../../../domain/money/money";
import { ledgerEntryFromRow } from "../mappers";
import type { LedgerEntryRow } from "../schemas";
import type { Db } from "../sql";

export class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly db: Db) {}

  async append(e: WalletLedgerEntry): Promise<void> {
    await this.db.run(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.id,
        e.walletId,
        e.transactionId,
        e.direction,
        e.money.amount,
        e.money.currency,
        e.balanceBefore.amount,
        e.balanceAfter.amount,
        e.createdAt,
      ],
    );
  }

  async list(walletId: string, afterSeq: bigint | undefined, limit: number): Promise<WalletLedgerEntry[]> {
    const after = afterSeq?.toString() ?? null;
    const rows = await this.db.rows<LedgerEntryRow>(
      `SELECT * FROM wallet_ledger_entries
        WHERE wallet_id = ? AND (?::bigint IS NULL OR seq > ?::bigint)
        ORDER BY seq
        LIMIT ?`,
      [walletId, after, after, limit],
    );
    return rows.map(ledgerEntryFromRow);
  }

  async totals(
    walletId: string,
  ): Promise<{ credits: Money; debits: Money; count: number; lastBalanceAfter?: Money }> {
    // Somas em SQL (NUMERIC); nada de somar em JS.
    const row = await this.db.one<{
      currency: string;
      credits: string;
      debits: string;
      entries: string;
      last_balance_after: string | null;
    }>(
      `SELECT w.currency,
              COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'CREDIT'), 0)::numeric(20,2)::text AS credits,
              COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'DEBIT'), 0)::numeric(20,2)::text AS debits,
              COUNT(l.id)::text AS entries,
              (SELECT balance_after::text FROM wallet_ledger_entries
                WHERE wallet_id = w.id ORDER BY seq DESC LIMIT 1) AS last_balance_after
         FROM wallets w
         LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ?
        GROUP BY w.id, w.currency`,
      [walletId],
    );
    if (!row) throw new NotFoundError(`wallet ${walletId} not found`);
    return {
      credits: Money.fromPersisted(row.credits, row.currency),
      debits: Money.fromPersisted(row.debits, row.currency),
      count: Number(row.entries),
      lastBalanceAfter:
        row.last_balance_after === null ? undefined : Money.fromPersisted(row.last_balance_after, row.currency),
    };
  }
}
