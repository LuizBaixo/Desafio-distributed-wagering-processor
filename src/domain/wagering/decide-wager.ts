import type { Wallet } from "../wallet/wallet";
import { LedgerDirection, WagerTransactionKind as K, WagerTransactionStatus as S } from "./enums";
import { FailureCode } from "./failure-code";
import type { WagerTransaction } from "./wager-transaction";

export type ReferenceLookup =
  | { state: "absent" } // sem referência no payload
  | { state: "missing" } // referenciada, não encontrada
  | { state: "found"; tx: WagerTransaction; alreadyReversed: boolean };

export type WagerDecision =
  | { type: "apply"; direction: LedgerDirection; referenceTransactionId?: string }
  | { type: "noop"; referenceTransactionId?: string } // LOSS
  | { type: "reject"; code: FailureCode }
  | { type: "pendingReference" };

const reject = (code: FailureCode): WagerDecision => ({ type: "reject", code });

/** Tipos de referência aceitos por kind da transação que referencia. */
function allowedReferenceKinds(kind: K): readonly K[] {
  return kind === K.Rollback ? [K.Bet, K.Win, K.Refund] : [K.Bet];
}

/**
 * Regras de negócio puras (Design §8, passos 6 a 8). Não altera a wallet nem a transação;
 * quem aplica a decisão é o motor.
 *
 * Ordem das checagens:
 *  1. player da wallet            -> WALLET_PLAYER_MISMATCH
 *  2. moeda                       -> CURRENCY_MISMATCH
 *  3. referência ausente ou pendente -> pendingReference
 *  4. referência REJECTED/FAILED  -> REFERENCE_NOT_PROCESSED
 *  5. provider/player/wallet/moeda/rodada -> REFERENCE_MISMATCH
 *  6. tipo da referência          -> REFERENCE_INVALID_KIND
 *  7. valor (REFUND, ROLLBACK)    -> AMOUNT_MISMATCH
 *  8. já revertida                -> REFERENCE_ALREADY_REVERSED
 *  9. saldo (só DEBIT)            -> INSUFFICIENT_FUNDS | REVERSAL_INSUFFICIENT_FUNDS
 * 10. LOSS -> noop; demais -> apply
 *
 * `BET` não usa referência: os passos 3 a 8 são ignorados para ela.
 */
export function decideWager(wallet: Wallet, tx: WagerTransaction, ref: ReferenceLookup): WagerDecision {
  if (tx.playerId !== wallet.playerId) return reject(FailureCode.WalletPlayerMismatch);
  if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);

  let reference: WagerTransaction | undefined;
  if (tx.kind !== K.Bet && ref.state !== "absent") {
    if (ref.state === "missing") return { type: "pendingReference" };
    reference = ref.tx;

    // Referência ainda não aplicada (PENDING_REFERENCE; PENDING nunca é persistido, mas não pode cair em apply).
    if (reference.status === S.PendingReference || reference.status === S.Pending) {
      return { type: "pendingReference" };
    }
    if (reference.status === S.Rejected || reference.status === S.Failed) {
      return reject(FailureCode.ReferenceNotProcessed);
    }
    if (
      reference.providerId !== tx.providerId ||
      reference.playerId !== tx.playerId ||
      reference.walletId !== tx.walletId ||
      reference.money.currency !== tx.money.currency ||
      reference.roundId !== tx.roundId
    ) {
      return reject(FailureCode.ReferenceMismatch);
    }
    if (!allowedReferenceKinds(tx.kind).includes(reference.kind)) {
      return reject(FailureCode.ReferenceInvalidKind);
    }
    if ((tx.kind === K.Refund || tx.kind === K.Rollback) && !reference.money.equals(tx.money)) {
      return reject(FailureCode.AmountMismatch);
    }
    if (ref.alreadyReversed) return reject(FailureCode.ReferenceAlreadyReversed);
  }

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === undefined) {
    return { type: "noop", referenceTransactionId: reference?.id };
  }
  if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(tx.money)) {
    return reject(tx.kind === K.Rollback ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
  }
  return { type: "apply", direction, referenceTransactionId: reference?.id };
}
