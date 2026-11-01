import type { WagerTransaction } from "../wagering/wager-transaction";
import type { Wallet } from "../wallet/wallet";
import type { WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import type { MoneyProps } from "../money/money";
import { LedgerDirection, WagerTransactionKind } from "../wagering/enums";
import { FailureCode } from "../wagering/failure-code";
import { IntegrationEvent, type EventContext } from "./integration-event";

function requireDefined<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`event data requires ${what}`);
  }
  return value;
}

// ---- WagerTransactionProcessed: qualquer transação aplicada, inclusive LOSS.

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  balanceAfter: MoneyProps;
  referenceTransactionId?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    const data: WagerTransactionProcessedData = {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      walletId: tx.walletId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      balanceAfter: requireDefined(tx.resultBalance, "resultBalance").toJSON(),
      ...(tx.referenceTransactionId !== undefined
        ? { referenceTransactionId: tx.referenceTransactionId }
        : {}),
    };
    return new WagerTransactionProcessed({
      eventId: ctx.eventId,
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data,
    });
  }
}

// ---- WagerTransactionRejected: rejeição por regra de negócio (transactionId pode faltar).

export interface WagerTransactionRejectedInput {
  transactionId?: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  failureCode: FailureCode;
}

export interface WagerTransactionRejectedData extends WagerTransactionRejectedInput {}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(input: WagerTransactionRejectedInput, ctx: EventContext): WagerTransactionRejected {
    const data: WagerTransactionRejectedData = {
      ...input,
    };
    return new WagerTransactionRejected({
      eventId: ctx.eventId,
      aggregateId: input.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data,
    });
  }
}

// ---- WagerTransactionPendingReference: referência ausente.

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  referenceExternalTransactionId: string;
  attempts: number;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    const data: WagerTransactionPendingReferenceData = {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      walletId: tx.walletId,
      kind: tx.kind,
      referenceExternalTransactionId: requireDefined(
        tx.referenceExternalTransactionId,
        "referenceExternalTransactionId",
      ),
      attempts: tx.attempts,
    };
    return new WagerTransactionPendingReference({
      eventId: ctx.eventId,
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data,
    });
  }
}

// ---- WalletBalanceChanged: somente quando o saldo muda.

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    const data: WalletBalanceChangedData = {
      walletId: wallet.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: wallet.version,
    };
    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data,
    });
  }
}

// ---- WalletCreated: emitido na abertura da wallet (extra).

export interface WalletCreatedData {
  walletId: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
}

export class WalletCreated extends IntegrationEvent<WalletCreatedData> {
  readonly eventType = "WalletCreated";
  readonly version = 1;

  static from(wallet: Wallet, ctx: EventContext): WalletCreated {
    const data: WalletCreatedData = {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
    return new WalletCreated({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data,
    });
  }
}
