import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import type { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { Money } from "../../domain/money/money";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";

export interface WalletRepository {
  /** `23505` em (player_id, currency) vira `DuplicateWalletError`. */
  insert(w: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | null>;
  /** Ids em ordem crescente, a partir do primeiro maior que `afterId` (ou do início, sem `afterId`). */
  listIdsAfter(afterId: string | undefined, limit: number): Promise<string[]>;
  /** `SELECT ... FOR UPDATE`. */
  lockForUpdate(id: string): Promise<Wallet | null>;
  lockForShare(id: string): Promise<Wallet | null>;
  /** `UPDATE ... WHERE id AND version = expectedVersion`; 0 linhas lança `ConcurrencyViolationError`. */
  saveBalance(w: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  insert(tx: WagerTransaction): Promise<void>;
  /** Grava só a allowlist mutável: status, referência interna, falha, snapshot, attempts, datas. */
  update(tx: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | null>;
  lockById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null>;
  /** Existe REFUND ou ROLLBACK PROCESSED apontando para esta transação. */
  isReversed(referenceTransactionId: string): Promise<boolean>;
  /** Marca `next_attempt_at = now` nos PENDING_REFERENCE que dependem deste id externo. */
  markDependentsDue(providerId: string, externalId: string, now: Date): Promise<number>;
  /** Claim por lease (Design §15): empurra `next_attempt_at` para `now + leaseSeconds`. */
  claimDuePending(
    limit: number,
    leaseSeconds: number,
    now: Date,
  ): Promise<Array<{ id: string; walletId: string }>>;
}

export interface LedgerRepository {
  append(e: WalletLedgerEntry): Promise<void>;
  list(walletId: string, afterSeq: bigint | undefined, limit: number): Promise<WalletLedgerEntry[]>;
  /** Lança `NotFoundError` se a wallet não existir. */
  totals(walletId: string): Promise<{ credits: Money; debits: Money; count: number; lastBalanceAfter?: Money }>;
}

export interface InboxRepository {
  /**
   * `INSERT ... ON CONFLICT DO NOTHING`. `duplicate`: messageId já visto com o mesmo payload_hash.
   * `conflict`: messageId já visto com payload_hash diferente (nada é gravado).
   */
  tryReceive(m: InboxMessage): Promise<"new" | "duplicate" | "conflict">;
  /**
   * Apaga até `limit` linhas recebidas antes de `cutoff` (e, se `processed_at` existir, também processadas
   * antes dele). Devolve quantas apagou.
   */
  purgeProcessedBefore(cutoff: Date, limit: number): Promise<number>;
}

export interface OutboxRepository {
  enqueue(m: OutboxMessage): Promise<void>;
  /** Claim por lease com `FOR UPDATE SKIP LOCKED` (Design §14). */
  claimDue(limit: number, leaseSeconds: number, now: Date): Promise<OutboxMessage[]>;
  markPublished(id: string, at: Date): Promise<void>;
  /** Marca como publicadas as pendentes entre `ids` e devolve as linhas afetadas. */
  markPublishedMany(ids: string[], at: Date): Promise<number>;
  /** Grava attempts e next_attempt_at e zera locked_until. */
  release(m: OutboxMessage): Promise<void>;
  oldestPendingAgeSeconds(now: Date): Promise<number>;
  /** Apaga até `limit` linhas publicadas antes de `cutoff`. Nunca toca em linha com `published_at` nulo. */
  purgePublishedBefore(cutoff: Date, limit: number): Promise<number>;
}
