import type { EntityManager } from "@mikro-orm/postgresql";
import type { Metrics } from "../../application/ports/metrics";
import type { TransactionScope, UnitOfWork } from "../../application/ports/unit-of-work";
import "./money.type";
import { mapPgError } from "./pg-error-mapper";
import { PgInboxRepository } from "./repositories/inbox.repository";
import { PgLedgerRepository } from "./repositories/ledger.repository";
import { PgOutboxRepository } from "./repositories/outbox.repository";
import { PgWagerTransactionRepository } from "./repositories/wager-transaction.repository";
import { PgWalletRepository } from "./repositories/wallet.repository";
import { Db } from "./sql";

const DEFAULT_LOCK_TIMEOUT = "5s";

export class MikroUnitOfWork implements UnitOfWork {
  constructor(
    private readonly em: EntityManager,
    private readonly lockTimeout: string = DEFAULT_LOCK_TIMEOUT,
    private readonly metrics?: Metrics,
  ) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    try {
      return await this.em.fork().transactional(async (tem) => {
        await tem.execute(`SET LOCAL lock_timeout = '${this.lockTimeout}'`);
        const db = new Db(tem);
        return work({
          wallets: new PgWalletRepository(db, this.metrics),
          transactions: new PgWagerTransactionRepository(db),
          ledger: new PgLedgerRepository(db),
          inbox: new PgInboxRepository(db),
          outbox: new PgOutboxRepository(db),
        });
      });
    } catch (e) {
      throw mapPgError(e);
    }
  }
}
