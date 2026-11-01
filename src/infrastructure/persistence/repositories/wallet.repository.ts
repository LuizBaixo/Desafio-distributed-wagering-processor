import { ConcurrencyViolationError, DuplicateWalletError } from "../../../application/errors";
import type { Metrics } from "../../../application/ports/metrics";
import type { WalletRepository } from "../../../application/ports/repositories";
import type { Wallet } from "../../../domain/wallet/wallet";
import { walletFromRow } from "../mappers";
import { isUniqueViolation } from "../pg-error-mapper";
import type { WalletRow } from "../schemas";
import type { Db } from "../sql";

export class PgWalletRepository implements WalletRepository {
  constructor(
    private readonly db: Db,
    private readonly metrics?: Metrics,
  ) {}

  async insert(w: Wallet): Promise<void> {
    try {
      await this.db.run(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [w.id, w.playerId, w.currency, w.balance.amount, w.version, w.createdAt, w.updatedAt],
      );
    } catch (e) {
      if (isUniqueViolation(e, "wallets_player_currency_uq")) throw new DuplicateWalletError();
      throw e;
    }
  }

  findById(id: string): Promise<Wallet | null> {
    return this.select(id, "");
  }

  async lockForUpdate(id: string): Promise<Wallet | null> {
    const started = performance.now();
    try {
      return await this.select(id, " FOR UPDATE");
    } finally {
      this.metrics?.observeLockWait((performance.now() - started) / 1000);
    }
  }

  lockForShare(id: string): Promise<Wallet | null> {
    return this.select(id, " FOR SHARE");
  }

  async saveBalance(w: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.db.run(
      `UPDATE wallets SET balance = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
      [w.balance.amount, w.version, w.updatedAt, w.id, expectedVersion],
    );
    if (affected === 0) {
      throw new ConcurrencyViolationError(`wallet ${w.id} is not at version ${expectedVersion}`);
    }
  }

  private async select(id: string, lock: string): Promise<Wallet | null> {
    const row = await this.db.one<WalletRow>(`SELECT * FROM wallets WHERE id = ?${lock}`, [id]);
    return row ? walletFromRow(row) : null;
  }
}
