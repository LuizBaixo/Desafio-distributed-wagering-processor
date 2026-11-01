import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";

/**
 * Campos de negócio que entram no hash (Design §9).
 * Header, messageId, idempotencyKey, occurredAt e type ficam de fora.
 * Tipo estrutural: o WagerCommand (Tarefa 10) é compatível com ele.
 */
export interface PayloadHashInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/** SHA-256 em hex sobre o JSON canônico dos campos de negócio. */
export function wagerPayloadHash(c: PayloadHashInput): string {
  const business = {
    providerId: c.providerId,
    externalTransactionId: c.externalTransactionId,
    playerId: c.playerId,
    walletId: c.walletId,
    roundId: c.roundId,
    gameId: c.gameId,
    kind: c.kind,
    money: { amount: c.money.amount, currency: c.money.currency },
    referenceExternalTransactionId: c.referenceExternalTransactionId,
  };
  return createHash("sha256").update(canonicalJson(business)).digest("hex");
}
