import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import {
  KindNotAllowedError,
  InvalidTransactionStateError,
  MissingReferenceError,
} from "../../../src/domain/shared/domain-error";
import { FailureCode } from "../../../src/domain/wagering/failure-code";
import {
  LedgerDirection,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../../src/domain/wagering/enums";
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from "../../../src/domain/wagering/wager-transaction";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const t0 = new Date("2026-10-31T00:00:00Z");
const t1 = new Date("2026-10-31T00:00:05Z");

let seq = 0;
const props = (over: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps => {
  seq += 1;
  return {
    id: `tx-${seq}`,
    providerId: "provider-a",
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `key-${seq}`,
    payloadHash: "abc",
    walletId: "w1",
    playerId: "p1",
    roundId: "r1",
    gameId: "g1",
    kind: Kind.Bet,
    money: brl("25.00"),
    createdAt: t0,
    ...over,
  };
};
const make = (kind: Kind, ref?: string) =>
  WagerTransaction.create(props({ kind, referenceExternalTransactionId: ref }));

describe("WagerTransaction.create", () => {
  test("starts PENDING with attempts 0", () => {
    const tx = make(Kind.Bet);
    expect(tx.status).toBe(Status.Pending);
    expect(tx.attempts).toBe(0);
    expect(tx.resultBalance).toBeUndefined();
    expect(tx.nextAttemptAt).toBeUndefined();
    expect(tx.isTerminal()).toBe(false);
  });

  test("REFUND without reference throws MissingReferenceError", () => {
    expect(() => make(Kind.Refund)).toThrow(MissingReferenceError);
  });

  test("ROLLBACK without reference throws MissingReferenceError", () => {
    expect(() => make(Kind.Rollback)).toThrow(MissingReferenceError);
  });

  test("REFUND with reference is accepted", () => {
    const tx = make(Kind.Refund, "ext-bet");
    expect(tx.hasReference()).toBe(true);
    expect(tx.requiresReference()).toBe(true);
  });

  test("OPENING through create throws KindNotAllowedError", () => {
    expect(() => make(Kind.Opening)).toThrow(KindNotAllowedError);
    try {
      make(Kind.Opening);
    } catch (e) {
      expect((e as KindNotAllowedError).code).toBe("KIND_NOT_ALLOWED");
    }
  });

  test("createOpening builds an OPENING transaction", () => {
    const { kind: _kind, ...rest } = props();
    const tx = WagerTransaction.createOpening(rest);
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.status).toBe(Status.Pending);
  });
});

describe("WagerTransaction transitions", () => {
  test("PENDING -> PROCESSED stores balance, reference id and processedAt", () => {
    const tx = make(Kind.Bet);
    tx.markProcessed("ref-id", brl("975.00"), t1);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe("ref-id");
    expect(tx.resultBalance?.amount).toBe("975.00");
    expect(tx.processedAt).toEqual(t1);
    expect(tx.isTerminal()).toBe(true);
  });

  test("PROCESSED then reject throws InvalidTransactionStateError", () => {
    const tx = make(Kind.Bet);
    tx.markProcessed(undefined, brl("1.00"), t1);
    expect(() => tx.reject(FailureCode.InsufficientFunds, undefined, t1)).toThrow(
      InvalidTransactionStateError,
    );
    expect(tx.status).toBe(Status.Processed);
  });

  test("REJECTED then markProcessed throws InvalidTransactionStateError", () => {
    const tx = make(Kind.Bet);
    tx.reject(FailureCode.InsufficientFunds, brl("10.00"), t1);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.resultBalance?.amount).toBe("10.00");
    expect(() => tx.markProcessed(undefined, brl("1.00"), t1)).toThrow(InvalidTransactionStateError);
  });

  test("REJECTED without balance keeps resultBalance undefined", () => {
    const tx = make(Kind.Bet);
    tx.reject(FailureCode.WalletPlayerMismatch, undefined, t1);
    expect(tx.resultBalance).toBeUndefined();
  });

  test("FAILED then markPendingReference throws InvalidTransactionStateError", () => {
    const tx = make(Kind.Bet);
    tx.fail(FailureCode.InfraPermanent, t1);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.InfraPermanent);
    expect(() => tx.markPendingReference(t1)).toThrow(InvalidTransactionStateError);
  });

  test("terminal state rejects every transition", () => {
    const tx = make(Kind.Bet);
    tx.fail(FailureCode.InfraPermanent, t1);
    expect(() => tx.fail(FailureCode.InfraPermanent, t1)).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientFunds, undefined, t1)).toThrow(
      InvalidTransactionStateError,
    );
  });

  test("InvalidTransactionStateError code is INVALID_TRANSACTION_STATE", () => {
    const tx = make(Kind.Bet);
    tx.fail(FailureCode.InfraPermanent, t1);
    try {
      tx.fail(FailureCode.InfraPermanent, t1);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as InvalidTransactionStateError).code).toBe("INVALID_TRANSACTION_STATE");
    }
  });

  test("PENDING -> PENDING_REFERENCE (attempts 0) -> PENDING_REFERENCE (attempts 1) -> PROCESSED", () => {
    const tx = make(Kind.Refund, "ext-bet");
    tx.markPendingReference(t1);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.attempts).toBe(0);
    expect(tx.nextAttemptAt).toEqual(t1);

    const t2 = new Date("2026-10-31T00:00:10Z");
    tx.markPendingReference(t2);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.attempts).toBe(1);
    expect(tx.nextAttemptAt).toEqual(t2);

    tx.markProcessed("bet-id", brl("100.00"), t2);
    expect(tx.status).toBe(Status.Processed);
  });

  test("PENDING_REFERENCE can be rejected", () => {
    const tx = make(Kind.Refund, "ext-bet");
    tx.markPendingReference(t1);
    tx.reject(FailureCode.ReferenceNotFound, undefined, t1);
    expect(tx.status).toBe(Status.Rejected);
  });
});

describe("WagerTransaction queries", () => {
  test("affectsBalance is false only for LOSS", () => {
    expect(make(Kind.Loss).affectsBalance()).toBe(false);
    expect(make(Kind.Bet).affectsBalance()).toBe(true);
    expect(make(Kind.Win).affectsBalance()).toBe(true);
    expect(make(Kind.Refund, "x").affectsBalance()).toBe(true);
  });

  test("requiresReference is true only for REFUND and ROLLBACK", () => {
    expect(make(Kind.Bet).requiresReference()).toBe(false);
    expect(make(Kind.Win).requiresReference()).toBe(false);
    expect(make(Kind.Refund, "x").requiresReference()).toBe(true);
    expect(make(Kind.Rollback, "x").requiresReference()).toBe(true);
  });

  test("hasReference is false for a BET without reference", () => {
    expect(make(Kind.Bet).hasReference()).toBe(false);
    expect(make(Kind.Win, "ext-bet").hasReference()).toBe(true);
  });

  test("matchesPayload is true only for the same hash", () => {
    const tx = make(Kind.Bet);
    expect(tx.matchesPayload("abc")).toBe(true);
    expect(tx.matchesPayload("abd")).toBe(false);
  });
});

describe("WagerTransaction.ledgerDirectionFor", () => {
  test("BET is DEBIT", () => {
    expect(make(Kind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
  });
  test("WIN, REFUND and OPENING are CREDIT", () => {
    expect(make(Kind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(Kind.Refund, "x").ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    const { kind: _k, ...rest } = props();
    expect(WagerTransaction.createOpening(rest).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
  test("LOSS is undefined", () => {
    expect(make(Kind.Loss).ledgerDirectionFor()).toBeUndefined();
  });
  test("ROLLBACK of BET is CREDIT", () => {
    expect(make(Kind.Rollback, "x").ledgerDirectionFor(make(Kind.Bet))).toBe(LedgerDirection.Credit);
  });
  test("ROLLBACK of WIN is DEBIT", () => {
    expect(make(Kind.Rollback, "x").ledgerDirectionFor(make(Kind.Win))).toBe(LedgerDirection.Debit);
  });
  test("ROLLBACK of REFUND is DEBIT", () => {
    expect(make(Kind.Rollback, "x").ledgerDirectionFor(make(Kind.Refund, "y"))).toBe(
      LedgerDirection.Debit,
    );
  });
  test("ROLLBACK without a reference throws MissingReferenceError", () => {
    expect(() => make(Kind.Rollback, "x").ledgerDirectionFor()).toThrow(MissingReferenceError);
  });
});

describe("FailureCode", () => {
  test("has exactly the Design §11 codes", () => {
    expect((Object.values(FailureCode) as string[]).sort()).toEqual(
      [
        "INVALID_PAYLOAD",
        "INVALID_MONEY",
        "KIND_NOT_ALLOWED",
        "IDEMPOTENCY_CONFLICT",
        "EXTERNAL_ID_CONFLICT",
        "WALLET_NOT_FOUND",
        "WALLET_PLAYER_MISMATCH",
        "CURRENCY_MISMATCH",
        "INSUFFICIENT_FUNDS",
        "REVERSAL_INSUFFICIENT_FUNDS",
        "REFERENCE_NOT_FOUND",
        "REFERENCE_MISMATCH",
        "REFERENCE_INVALID_KIND",
        "REFERENCE_NOT_PROCESSED",
        "REFERENCE_ALREADY_REVERSED",
        "AMOUNT_MISMATCH",
        "INFRA_UNAVAILABLE",
        "INFRA_PERMANENT",
      ].sort(),
    );
  });
});

describe("WagerTransaction.rehydrate", () => {
  test("restores state without revalidating transitions", () => {
    const tx = WagerTransaction.rehydrate({
      ...props({ kind: Kind.Refund, referenceExternalTransactionId: "ext-bet" }),
      status: Status.PendingReference,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
      resultBalance: brl("10.00"),
      attempts: 3,
      nextAttemptAt: t1,
    });
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.attempts).toBe(3);
    expect(tx.nextAttemptAt).toEqual(t1);
    expect(tx.resultBalance?.amount).toBe("10.00");
  });
});
