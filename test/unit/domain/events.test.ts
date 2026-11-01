import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { WalletLedgerEntry } from "../../../src/domain/ledger/wallet-ledger-entry";
import { WagerTransaction } from "../../../src/domain/wagering/wager-transaction";
import { WagerTransactionKind, WagerTransactionStatus, LedgerDirection } from "../../../src/domain/wagering/enums";
import { FailureCode } from "../../../src/domain/wagering/failure-code";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  WalletCreated,
} from "../../../src/domain/events/events";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const t0 = new Date("2026-10-31T00:00:00.000Z");
const ctx = { eventId: "evt-1", correlationId: "corr-1", causationId: "msg-1", occurredAt: t0 };

const wallet = Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("100.00"), at: t0 });

function bet(amount: string, refId?: string) {
  return WagerTransaction.create({
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    idempotencyKey: "provider-a:transaction-123",
    payloadHash: "h",
    walletId: "w1",
    playerId: "p1",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: brl(amount),
    referenceExternalTransactionId: refId,
    createdAt: t0,
  });
}

describe("WalletBalanceChanged", () => {
  test("toJSON tem eventType, version 1, occurredAt ISO e money como string", () => {
    const w = Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("100.00"), at: t0 });
    const entry = w.debit({ money: brl("20.00"), transactionId: "tx-1", entryId: "e-1", at: t0 });
    const event = WalletBalanceChanged.from(w, entry, ctx);
    const json = event.toJSON();

    expect(json.eventType).toBe("WalletBalanceChanged");
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe(t0.toISOString());
    expect(json.eventId).toBe("evt-1");
    expect(json.aggregateId).toBe("w1");
    expect(json.correlationId).toBe("corr-1");
    expect(json.causationId).toBe("msg-1");
    expect(json.data.money).toEqual({ amount: "20.00", currency: "BRL" });
    expect(json.data.balanceAfter).toEqual({ amount: "80.00", currency: "BRL" });
  });

  test("data.money é string decimal, nunca instância de Money", () => {
    const entry = WalletLedgerEntry.create({
      id: "e-2",
      walletId: "w1",
      transactionId: "tx-2",
      direction: LedgerDirection.Credit,
      money: brl("80.00"),
      balanceBefore: brl("100.00"),
      balanceAfter: brl("180.00"),
      createdAt: t0,
    });
    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();
    expect(typeof json.data.money.amount).toBe("string");
    expect(json.data.money.amount).toBe("80.00");
  });
});

describe("WagerTransactionProcessed", () => {
  test("carrega resultado e referência opcional", () => {
    const tx = bet("25.00");
    tx.markProcessed(undefined, brl("75.00"), t0);
    const json = WagerTransactionProcessed.from(tx, ctx).toJSON();
    expect(json.eventType).toBe("WagerTransactionProcessed");
    expect(json.aggregateId).toBe("w1");
    expect(json.data).toMatchObject({
      transactionId: "tx-1",
      providerId: "provider-a",
      externalTransactionId: "transaction-123",
      walletId: "w1",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      balanceAfter: { amount: "75.00", currency: "BRL" },
    });
  });
});

describe("WagerTransactionRejected", () => {
  test("aceita transactionId ausente (WALLET_NOT_FOUND)", () => {
    const json = WagerTransactionRejected.from(
      {
        providerId: "provider-a",
        externalTransactionId: "transaction-123",
        walletId: "w-missing",
        kind: WagerTransactionKind.Bet,
        failureCode: FailureCode.WalletNotFound,
      },
      ctx,
    ).toJSON();
    expect(json.eventType).toBe("WagerTransactionRejected");
    expect(json.aggregateId).toBe("w-missing");
    expect(json.data).toMatchObject({ failureCode: "WALLET_NOT_FOUND", walletId: "w-missing" });
    expect("transactionId" in json.data).toBe(false);
  });
});

describe("WagerTransactionPendingReference", () => {
  test("carrega referência externa e attempts", () => {
    const tx = bet("25.00", "transaction-000");
    tx.markPendingReference(t0);
    const json = WagerTransactionPendingReference.from(tx, ctx).toJSON();
    expect(json.eventType).toBe("WagerTransactionPendingReference");
    expect(json.data).toMatchObject({
      transactionId: "tx-1",
      referenceExternalTransactionId: "transaction-000",
      attempts: 0,
    });
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
  });
});

describe("WalletCreated", () => {
  test("emite dados da wallet com money em string", () => {
    const json = WalletCreated.from(wallet, ctx).toJSON();
    expect(json.eventType).toBe("WalletCreated");
    expect(json.data).toMatchObject({ walletId: "w1", playerId: "p1", currency: "BRL", version: 1 });
    expect(json.data.balance).toEqual({ amount: "100.00", currency: "BRL" });
  });
});
