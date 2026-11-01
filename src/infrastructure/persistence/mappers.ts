import { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money } from "../../domain/money/money";
import type { LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from "../../domain/wagering/enums";
import type { FailureCode } from "../../domain/wagering/failure-code";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import type { DbDate, LedgerEntryRow, OutboxRow, WagerTransactionRow, WalletRow } from "./schemas";

const orUndefined = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

export function walletFromRow(r: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.player_id,
    currency: r.currency,
    balance: Money.fromPersisted(r.balance, r.currency),
    version: r.version,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  });
}

export function transactionFromRow(r: WagerTransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.provider_id,
    externalTransactionId: r.external_transaction_id,
    idempotencyKey: r.idempotency_key,
    payloadHash: r.payload_hash,
    walletId: r.wallet_id,
    playerId: r.player_id,
    roundId: r.round_id,
    gameId: r.game_id,
    kind: r.kind as WagerTransactionKind,
    money: Money.fromPersisted(r.amount, r.currency),
    referenceExternalTransactionId: orUndefined(r.reference_external_transaction_id),
    createdAt: toDate(r.created_at),
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: orUndefined(r.reference_transaction_id),
    failureCode: orUndefined(r.failure_code) as FailureCode | undefined,
    processedAt: toOptDate(r.processed_at),
    resultBalance:
      r.result_balance !== null && r.result_currency !== null
        ? Money.fromPersisted(r.result_balance, r.result_currency)
        : undefined,
    attempts: r.attempts,
    nextAttemptAt: toOptDate(r.next_attempt_at),
  });
}

export function ledgerEntryFromRow(r: LedgerEntryRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    seq: BigInt(r.seq),
    walletId: r.wallet_id,
    transactionId: r.transaction_id,
    direction: r.direction as LedgerDirection,
    money: Money.fromPersisted(r.amount, r.currency),
    balanceBefore: Money.fromPersisted(r.balance_before, r.currency),
    balanceAfter: Money.fromPersisted(r.balance_after, r.currency),
    createdAt: toDate(r.created_at),
  });
}

export function outboxFromRow(r: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregate_id,
    eventType: r.event_type,
    payload: r.payload,
    occurredAt: toDate(r.occurred_at),
    attempts: r.attempts,
    nextAttemptAt: toOptDate(r.next_attempt_at),
    publishedAt: toOptDate(r.published_at),
  });
}

const PG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2})(?::?(\d{2}))?$/;

/** Converte timestamptz do driver (Date ou `2026-10-31 12:00:00.123456+00`) em Date, com precisão de ms. */
export function toDate(v: DbDate): Date {
  if (v instanceof Date) return v;
  const m = PG_TIMESTAMP.exec(v);
  if (!m) {
    const fallback = new Date(v);
    if (Number.isNaN(fallback.getTime())) throw new Error(`unparseable timestamp from database: ${v}`);
    return fallback;
  }
  const [, day, time, frac = "", offH = "+00", offM = "00"] = m;
  const millis = frac === "" ? "" : `.${frac.slice(1, 4).padEnd(3, "0")}`;
  return new Date(`${day}T${time}${millis}${offH}:${offM}`);
}

function toOptDate(v: DbDate | null): Date | undefined {
  return v === null ? undefined : toDate(v);
}
