import { describe, expect, test } from "bun:test";
import fc from "fast-check";
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

const RUNS = { numRuns: 500 };
const WALLET_ID = "wallet-1";
const PLAYER_ID = "player-1";
const at = new Date("2026-10-31T00:00:00Z");

const centsArb = fc.bigInt({ min: 0n, max: 99999999999999999999n });
const positiveCentsArb = fc.bigInt({ min: 1n, max: 99999999999999999999n });
const toAmount = (c: bigint): string => `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`;
const money = (c: bigint, currency = "BRL") => Money.from({ amount: toAmount(c), currency });

let seq = 0;
function newWallet(balance: bigint): Wallet {
  return Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: money(balance), at });
}

function incoming(kind: Kind, amount: Money, ref?: string, roundId = "round-1"): WagerTransaction {
  seq += 1;
  return WagerTransaction.create({
    id: `in-${seq}`,
    providerId: "provider-a",
    externalTransactionId: `ext-in-${seq}`,
    idempotencyKey: `key-${seq}`,
    payloadHash: "h",
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId,
    gameId: "game-1",
    kind,
    money: amount,
    referenceExternalTransactionId: ref,
    createdAt: at,
  });
}

describe("decideWager: propriedades", () => {
  // Pré-condição: valor positivo. `parseWagerCommand` rejeita 0.00 antes de chegar aqui.
  test("BET: apply DEBIT se v <= s, senão reject INSUFFICIENT_FUNDS", () => {
    fc.assert(
      fc.property(centsArb, positiveCentsArb, (s, v) => {
        const decision = decideWager(newWallet(s), incoming(Kind.Bet, money(v)), { state: "absent" });
        if (v <= s) {
          expect(decision).toEqual({ type: "apply", direction: Dir.Debit, referenceTransactionId: undefined });
        } else {
          expect(decision).toEqual({ type: "reject", code: FailureCode.InsufficientFunds });
        }
      }),
      RUNS,
    );
  });

  test("sequência aleatória de até 30 operações: saldo nunca negativo e soma dos lançamentos = saldo final - inicial", () => {
    const opArb = fc.record({
      type: fc.constantFrom(Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback),
      cents: fc.bigInt({ min: 1n, max: 100000n }),
      pick: fc.nat(),
    });

    fc.assert(
      fc.property(centsArb, fc.array(opArb, { maxLength: 30 }), (initial, ops) => {
        const wallet = newWallet(initial);
        const processed = new Map<string, WagerTransaction>();
        const reversed = new Set<string>();
        let signedSum = 0n;

        for (const op of ops) {
          // REFUND e ROLLBACK precisam de uma referência processada, do tipo certo, de mesmo valor.
          const eligible = [...processed.values()].filter((t) =>
            op.type === Kind.Refund
              ? t.kind === Kind.Bet
              : op.type === Kind.Rollback
                ? t.kind === Kind.Bet || t.kind === Kind.Win || t.kind === Kind.Refund
                : false,
          );
          const reference = op.type === Kind.Refund || op.type === Kind.Rollback
            ? eligible[op.pick % Math.max(eligible.length, 1)]
            : undefined;

          const isRef = op.type === Kind.Refund || op.type === Kind.Rollback;
          if (isRef && !reference) continue; // sem referência válida, a operação não existe nesta sequência

          const amount = isRef ? reference!.money : money(op.cents);
          const tx = incoming(op.type, amount, reference?.externalTransactionId);
          const lookup: ReferenceLookup = reference
            ? { state: "found", tx: reference, alreadyReversed: reversed.has(reference.id) }
            : { state: "absent" };

          const decision = decideWager(wallet, tx, lookup);
          if (decision.type === "apply") {
            const movement = { money: tx.money, transactionId: tx.id, entryId: `e-${seq}`, at };
            if (decision.direction === Dir.Debit) {
              wallet.debit(movement);
              signedSum -= BigInt(tx.money.amount.replace(".", ""));
            } else {
              wallet.credit(movement);
              signedSum += BigInt(tx.money.amount.replace(".", ""));
            }
            tx.markProcessed(decision.referenceTransactionId, wallet.balance, at);
            processed.set(tx.id, tx);
            if (reference) reversed.add(reference.id);
          } else if (decision.type === "noop") {
            tx.markProcessed(decision.referenceTransactionId, wallet.balance, at);
          }
          // reject e pendingReference não mudam a wallet.

          expect(wallet.balance.isNegative()).toBe(false);
        }

        const finalCents = BigInt(wallet.balance.amount.replace(".", ""));
        expect(finalCents - initial).toBe(signedSum);
        expect(hasUnprocessed(processed)).toBe(false);
      }),
      RUNS,
    );
  });
});

/** Guarda: nenhuma transação aplicada pode ter ficado em PENDING ou PENDING_REFERENCE. */
function hasUnprocessed(processed: Map<string, WagerTransaction>): boolean {
  return [...processed.values()].some((t) => t.status !== Status.Processed);
}
