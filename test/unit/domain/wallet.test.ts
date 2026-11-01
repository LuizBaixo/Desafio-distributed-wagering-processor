import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { LedgerDirection } from "../../../src/domain/wagering/enums";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
} from "../../../src/domain/shared/domain-error";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });
const t0 = new Date("2026-10-31T00:00:00Z");
const t1 = new Date("2026-10-31T00:00:01Z");

const open = (balance = "100.00") =>
  Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl(balance), at: t0 });
const mv = (money: Money, at = t1) => ({ money, transactionId: "t1", entryId: "e1", at });

describe("Wallet.open", () => {
  test("starts at version 1 with the initial balance", () => {
    const w = open();
    expect(w.version).toBe(1);
    expect(w.balance.amount).toBe("100.00");
    expect(w.currency).toBe("BRL");
    expect(w.createdAt).toEqual(t0);
    expect(w.updatedAt).toEqual(t0);
  });

  test("rejects negative initial balance", () => {
    expect(() =>
      Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("1.00").negate(), at: t0 }),
    ).toThrow(InvalidMoneyError);
  });

  test("accepts zero initial balance", () => {
    expect(open("0.00").balance.isZero()).toBe(true);
  });
});

describe("Wallet.debit", () => {
  test("80.00 over 100.00 leaves 20.00, version 2, balanced DEBIT entry", () => {
    const w = open();
    const e = w.debit(mv(brl("80.00")));
    expect(w.balance.amount).toBe("20.00");
    expect(w.version).toBe(2);
    expect(w.updatedAt).toEqual(t1);
    expect(e.direction).toBe(LedgerDirection.Debit);
    expect(e.balanceBefore.amount).toBe("100.00");
    expect(e.balanceAfter.amount).toBe("20.00");
    expect(e.walletId).toBe("w1");
    expect(e.transactionId).toBe("t1");
    expect(e.id).toBe("e1");
    expect(e.isBalanced()).toBe(true);
  });

  test("second 80.00 throws InsufficientFundsError and leaves state intact", () => {
    const w = open();
    w.debit(mv(brl("80.00")));
    expect(() => w.debit(mv(brl("80.00")))).toThrow(InsufficientFundsError);
    expect(w.balance.amount).toBe("20.00");
    expect(w.version).toBe(2);
  });

  test("debit of the exact balance is allowed", () => {
    const w = open();
    w.debit(mv(brl("100.00")));
    expect(w.balance.amount).toBe("0.00");
  });

  test("zero debit throws InvalidMoneyError", () => {
    expect(() => open().debit(mv(brl("0.00")))).toThrow(InvalidMoneyError);
  });

  test("USD debit on BRL wallet throws CurrencyMismatchError", () => {
    expect(() => open().debit(mv(usd("1.00")))).toThrow(CurrencyMismatchError);
  });

  test("InsufficientFundsError code is INSUFFICIENT_FUNDS", () => {
    try {
      open().debit(mv(brl("100.01")));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as InsufficientFundsError).code).toBe("INSUFFICIENT_FUNDS");
    }
  });
});

describe("Wallet.credit", () => {
  test("adds to balance, bumps version, balanced CREDIT entry", () => {
    const w = open();
    const e = w.credit(mv(brl("0.10")));
    expect(w.balance.amount).toBe("100.10");
    expect(w.version).toBe(2);
    expect(e.direction).toBe(LedgerDirection.Credit);
    expect(e.balanceBefore.amount).toBe("100.00");
    expect(e.balanceAfter.amount).toBe("100.10");
    expect(e.isBalanced()).toBe(true);
  });

  test("USD credit on BRL wallet throws CurrencyMismatchError", () => {
    const w = open();
    expect(() => w.credit(mv(usd("1.00")))).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });

  test("zero credit throws InvalidMoneyError", () => {
    expect(() => open().credit(mv(brl("0.00")))).toThrow(InvalidMoneyError);
  });
});

describe("Wallet.rehydrate", () => {
  test("keeps version 7 and does not validate", () => {
    const w = Wallet.rehydrate({
      id: "w1",
      playerId: "p1",
      currency: "BRL",
      balance: brl("5.00"),
      version: 7,
      createdAt: t0,
      updatedAt: t1,
    });
    expect(w.version).toBe(7);
    expect(w.balance.amount).toBe("5.00");
    expect(w.updatedAt).toEqual(t1);
  });
});
