import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import { Wallet } from "../../../src/domain/wallet/wallet";
import {
  LedgerDirection as Dir,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../../src/domain/wagering/enums";
import { FailureCode } from "../../../src/domain/wagering/failure-code";
import { WagerTransaction } from "../../../src/domain/wagering/wager-transaction";
import { decideWager, type ReferenceLookup } from "../../../src/domain/wagering/decide-wager";

const money = (amount: string, currency = "BRL") => Money.from({ amount, currency });
const at = new Date("2026-10-31T00:00:00Z");

const WALLET_ID = "wallet-1";
const PLAYER_ID = "player-1";

const wallet = (balance = "100.00") =>
  Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: money(balance), at });

let n = 0;
interface TxOver {
  kind: Kind;
  amount?: string;
  currency?: string;
  playerId?: string;
  roundId?: string;
  ref?: string;
}
const incoming = (o: TxOver): WagerTransaction => {
  n += 1;
  return WagerTransaction.create({
    id: `in-${n}`,
    providerId: "provider-a",
    externalTransactionId: `ext-in-${n}`,
    idempotencyKey: `key-${n}`,
    payloadHash: "h",
    walletId: WALLET_ID,
    playerId: o.playerId ?? PLAYER_ID,
    roundId: o.roundId ?? "round-1",
    gameId: "game-1",
    kind: o.kind,
    money: money(o.amount ?? "25.00", o.currency ?? "BRL"),
    referenceExternalTransactionId: o.ref,
    createdAt: at,
  });
};

interface RefOver {
  kind?: Kind;
  amount?: string;
  status?: Status;
  roundId?: string;
  providerId?: string;
  playerId?: string;
  walletId?: string;
  currency?: string;
}
const refTx = (o: RefOver = {}): WagerTransaction => {
  n += 1;
  return WagerTransaction.rehydrate({
    id: `ref-${n}`,
    providerId: o.providerId ?? "provider-a",
    externalTransactionId: `ext-ref-${n}`,
    idempotencyKey: `key-ref-${n}`,
    payloadHash: "h",
    walletId: o.walletId ?? WALLET_ID,
    playerId: o.playerId ?? PLAYER_ID,
    roundId: o.roundId ?? "round-1",
    gameId: "game-1",
    kind: o.kind ?? Kind.Bet,
    money: money(o.amount ?? "25.00", o.currency ?? "BRL"),
    createdAt: at,
    status: o.status ?? Status.Processed,
    attempts: 0,
  });
};

const found = (tx: WagerTransaction, alreadyReversed = false): ReferenceLookup => ({
  state: "found",
  tx,
  alreadyReversed,
});
const absent: ReferenceLookup = { state: "absent" };
const missing: ReferenceLookup = { state: "missing" };

describe("decideWager: table of cases (wallet 100.00 BRL)", () => {
  test("BET 25.00 without reference -> apply DEBIT", () => {
    expect(decideWager(wallet(), incoming({ kind: Kind.Bet }), absent)).toEqual({
      type: "apply",
      direction: Dir.Debit,
      referenceTransactionId: undefined,
    });
  });

  test("BET 100.01 -> reject INSUFFICIENT_FUNDS", () => {
    expect(decideWager(wallet(), incoming({ kind: Kind.Bet, amount: "100.01" }), absent)).toEqual({
      type: "reject",
      code: FailureCode.InsufficientFunds,
    });
  });

  test("BET with a different player -> reject WALLET_PLAYER_MISMATCH", () => {
    expect(decideWager(wallet(), incoming({ kind: Kind.Bet, playerId: "other" }), absent)).toEqual({
      type: "reject",
      code: FailureCode.WalletPlayerMismatch,
    });
  });

  test("BET in USD -> reject CURRENCY_MISMATCH", () => {
    expect(decideWager(wallet(), incoming({ kind: Kind.Bet, currency: "USD" }), absent)).toEqual({
      type: "reject",
      code: FailureCode.CurrencyMismatch,
    });
  });

  test("WIN 300.00 without reference -> apply CREDIT", () => {
    expect(decideWager(wallet(), incoming({ kind: Kind.Win, amount: "300.00" }), absent)).toEqual({
      type: "apply",
      direction: Dir.Credit,
      referenceTransactionId: undefined,
    });
  });

  test("WIN 300.00 referencing a PROCESSED BET 25.00 -> apply CREDIT with the BET id", () => {
    const bet = refTx();
    const d = decideWager(wallet(), incoming({ kind: Kind.Win, amount: "300.00", ref: "x" }), found(bet));
    expect(d).toEqual({ type: "apply", direction: Dir.Credit, referenceTransactionId: bet.id });
  });

  test("WIN with missing reference -> pendingReference", () => {
    expect(decideWager(wallet(), incoming({ kind: Kind.Win, ref: "x" }), missing)).toEqual({
      type: "pendingReference",
    });
  });

  test("WIN referencing a LOSS -> reject REFERENCE_INVALID_KIND", () => {
    const loss = refTx({ kind: Kind.Loss });
    expect(decideWager(wallet(), incoming({ kind: Kind.Win, ref: "x" }), found(loss))).toEqual({
      type: "reject",
      code: FailureCode.ReferenceInvalidKind,
    });
  });

  test("WIN referencing an already reversed BET -> reject REFERENCE_ALREADY_REVERSED", () => {
    expect(decideWager(wallet(), incoming({ kind: Kind.Win, ref: "x" }), found(refTx(), true))).toEqual({
      type: "reject",
      code: FailureCode.ReferenceAlreadyReversed,
    });
  });

  test("LOSS referencing a BET -> noop", () => {
    const bet = refTx();
    expect(decideWager(wallet(), incoming({ kind: Kind.Loss, ref: "x" }), found(bet))).toEqual({
      type: "noop",
      referenceTransactionId: bet.id,
    });
  });

  test("REFUND 25.00 of PROCESSED BET 25.00 -> apply CREDIT", () => {
    const bet = refTx();
    expect(decideWager(wallet(), incoming({ kind: Kind.Refund, ref: "x" }), found(bet))).toEqual({
      type: "apply",
      direction: Dir.Credit,
      referenceTransactionId: bet.id,
    });
  });

  test("REFUND 20.00 of BET 25.00 -> reject AMOUNT_MISMATCH", () => {
    expect(
      decideWager(wallet(), incoming({ kind: Kind.Refund, amount: "20.00", ref: "x" }), found(refTx())),
    ).toEqual({ type: "reject", code: FailureCode.AmountMismatch });
  });

  test("REFUND of a WIN -> reject REFERENCE_INVALID_KIND", () => {
    expect(
      decideWager(wallet(), incoming({ kind: Kind.Refund, ref: "x" }), found(refTx({ kind: Kind.Win }))),
    ).toEqual({ type: "reject", code: FailureCode.ReferenceInvalidKind });
  });

  test("REFUND of a BET with a different roundId -> reject REFERENCE_MISMATCH", () => {
    expect(
      decideWager(
        wallet(),
        incoming({ kind: Kind.Refund, ref: "x" }),
        found(refTx({ roundId: "round-2" })),
      ),
    ).toEqual({ type: "reject", code: FailureCode.ReferenceMismatch });
  });

  test("REFUND of a REJECTED BET -> reject REFERENCE_NOT_PROCESSED", () => {
    expect(
      decideWager(
        wallet(),
        incoming({ kind: Kind.Refund, ref: "x" }),
        found(refTx({ status: Status.Rejected })),
      ),
    ).toEqual({ type: "reject", code: FailureCode.ReferenceNotProcessed });
  });

  test("REFUND of a BET in PENDING_REFERENCE -> pendingReference", () => {
    expect(
      decideWager(
        wallet(),
        incoming({ kind: Kind.Refund, ref: "x" }),
        found(refTx({ status: Status.PendingReference })),
      ),
    ).toEqual({ type: "pendingReference" });
  });

  test("second REFUND of the same BET (alreadyReversed) -> reject REFERENCE_ALREADY_REVERSED", () => {
    expect(
      decideWager(wallet(), incoming({ kind: Kind.Refund, ref: "x" }), found(refTx(), true)),
    ).toEqual({ type: "reject", code: FailureCode.ReferenceAlreadyReversed });
  });

  test("ROLLBACK of BET -> apply CREDIT", () => {
    const bet = refTx();
    expect(decideWager(wallet(), incoming({ kind: Kind.Rollback, ref: "x" }), found(bet))).toEqual({
      type: "apply",
      direction: Dir.Credit,
      referenceTransactionId: bet.id,
    });
  });

  test("ROLLBACK 300.00 of WIN 300.00 with balance 100.00 -> reject REVERSAL_INSUFFICIENT_FUNDS", () => {
    const win = refTx({ kind: Kind.Win, amount: "300.00" });
    expect(
      decideWager(wallet(), incoming({ kind: Kind.Rollback, amount: "300.00", ref: "x" }), found(win)),
    ).toEqual({ type: "reject", code: FailureCode.ReversalInsufficientFunds });
  });

  test("ROLLBACK of REFUND -> apply DEBIT", () => {
    const refund = refTx({ kind: Kind.Refund });
    expect(decideWager(wallet(), incoming({ kind: Kind.Rollback, ref: "x" }), found(refund))).toEqual({
      type: "apply",
      direction: Dir.Debit,
      referenceTransactionId: refund.id,
    });
  });

  test("ROLLBACK with missing reference -> pendingReference", () => {
    expect(decideWager(wallet(), incoming({ kind: Kind.Rollback, ref: "x" }), missing)).toEqual({
      type: "pendingReference",
    });
  });
});

describe("decideWager: check order", () => {
  test("player mismatch wins over currency mismatch", () => {
    const tx = incoming({ kind: Kind.Bet, playerId: "other", currency: "USD" });
    expect(decideWager(wallet(), tx, absent)).toEqual({
      type: "reject",
      code: FailureCode.WalletPlayerMismatch,
    });
  });

  test("currency mismatch wins over a missing reference", () => {
    const tx = incoming({ kind: Kind.Refund, currency: "USD", ref: "x" });
    expect(decideWager(wallet(), tx, missing)).toEqual({
      type: "reject",
      code: FailureCode.CurrencyMismatch,
    });
  });

  test("REFERENCE_NOT_PROCESSED wins over REFERENCE_MISMATCH", () => {
    const ref = refTx({ status: Status.Failed, roundId: "round-2" });
    expect(decideWager(wallet(), incoming({ kind: Kind.Refund, ref: "x" }), found(ref))).toEqual({
      type: "reject",
      code: FailureCode.ReferenceNotProcessed,
    });
  });

  test("REFERENCE_MISMATCH wins over REFERENCE_INVALID_KIND", () => {
    const ref = refTx({ kind: Kind.Win, roundId: "round-2" });
    expect(decideWager(wallet(), incoming({ kind: Kind.Refund, ref: "x" }), found(ref))).toEqual({
      type: "reject",
      code: FailureCode.ReferenceMismatch,
    });
  });

  test("REFERENCE_INVALID_KIND wins over AMOUNT_MISMATCH", () => {
    const ref = refTx({ kind: Kind.Win, amount: "99.00" });
    expect(decideWager(wallet(), incoming({ kind: Kind.Refund, ref: "x" }), found(ref))).toEqual({
      type: "reject",
      code: FailureCode.ReferenceInvalidKind,
    });
  });

  test("AMOUNT_MISMATCH wins over REFERENCE_ALREADY_REVERSED", () => {
    const tx = incoming({ kind: Kind.Refund, amount: "20.00", ref: "x" });
    expect(decideWager(wallet(), tx, found(refTx(), true))).toEqual({
      type: "reject",
      code: FailureCode.AmountMismatch,
    });
  });

  test("REFERENCE_ALREADY_REVERSED wins over insufficient funds", () => {
    const win = refTx({ kind: Kind.Win, amount: "300.00" });
    const tx = incoming({ kind: Kind.Rollback, amount: "300.00", ref: "x" });
    expect(decideWager(wallet(), tx, found(win, true))).toEqual({
      type: "reject",
      code: FailureCode.ReferenceAlreadyReversed,
    });
  });

  test("WIN does not check amount against its reference", () => {
    const d = decideWager(wallet(), incoming({ kind: Kind.Win, amount: "999.00", ref: "x" }), found(refTx()));
    expect(d.type).toBe("apply");
  });

  test("reference mismatch on provider, player, wallet and currency", () => {
    const cases: RefOver[] = [
      { providerId: "provider-b" },
      { playerId: "other" },
      { walletId: "wallet-2" },
      { currency: "USD" },
    ];
    for (const c of cases) {
      const d = decideWager(wallet(), incoming({ kind: Kind.Refund, ref: "x" }), found(refTx(c)));
      expect(d).toEqual({ type: "reject", code: FailureCode.ReferenceMismatch });
    }
  });

  test("decideWager does not mutate the wallet", () => {
    const w = wallet();
    decideWager(w, incoming({ kind: Kind.Bet }), absent);
    expect(w.balance.amount).toBe("100.00");
    expect(w.version).toBe(1);
  });
});
