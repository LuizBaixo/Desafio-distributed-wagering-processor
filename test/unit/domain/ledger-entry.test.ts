import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import { LedgerDirection } from "../../../src/domain/wagering/enums";
import { WalletLedgerEntry } from "../../../src/domain/ledger/wallet-ledger-entry";
import { UnbalancedLedgerEntryError } from "../../../src/domain/shared/domain-error";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });

const base = {
  id: "e1",
  walletId: "w1",
  transactionId: "t1",
  createdAt: new Date("2026-10-31T00:00:00Z"),
};

describe("WalletLedgerEntry.create", () => {
  test("DEBIT 30 from 100 to 80 throws UnbalancedLedgerEntryError", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl("30.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("80.00"),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test("DEBIT 30 from 100 to 70 is balanced", () => {
    const e = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl("30.00"),
      balanceBefore: brl("100.00"),
      balanceAfter: brl("70.00"),
    });
    expect(e.isBalanced()).toBe(true);
  });

  test("CREDIT 30 from 100 to 130 is balanced and has no seq", () => {
    const e = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl("30.00"),
      balanceBefore: brl("100.00"),
      balanceAfter: brl("130.00"),
    });
    expect(e.isBalanced()).toBe(true);
    expect(e.seq).toBeUndefined();
  });

  test("zero money throws UnbalancedLedgerEntryError", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl("0.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("100.00"),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test("mixed currencies throw UnbalancedLedgerEntryError", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: usd("30.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("130.00"),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test("error code is UNBALANCED_LEDGER_ENTRY", () => {
    try {
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl("30.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("80.00"),
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as UnbalancedLedgerEntryError).code).toBe("UNBALANCED_LEDGER_ENTRY");
    }
  });
});

describe("WalletLedgerEntry.rehydrate", () => {
  test("keeps seq and does not validate", () => {
    const e = WalletLedgerEntry.rehydrate({
      ...base,
      seq: 42n,
      direction: LedgerDirection.Debit,
      money: brl("30.00"),
      balanceBefore: brl("100.00"),
      balanceAfter: brl("80.00"),
    });
    expect(e.seq).toBe(42n);
    expect(e.isBalanced()).toBe(false);
  });
});

describe("WalletLedgerEntry immutability", () => {
  test("prototype has no setters", () => {
    const descriptors = Object.getOwnPropertyDescriptors(WalletLedgerEntry.prototype);
    for (const d of Object.values(descriptors)) {
      expect(d.set).toBeUndefined();
    }
  });
});
