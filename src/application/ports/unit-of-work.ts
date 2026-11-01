import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from "./repositories";

/** Repositórios ligados à mesma transação SQL. Só valem dentro de `UnitOfWork.run`. */
export interface TransactionScope {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  /** Uma transação SQL: commit se `work` resolver, rollback se lançar. */
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");
