import type { UnitOfWork } from "../ports/unit-of-work";
import type { MoneyProps } from "../../domain/money/money";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";

/** Todos os campos públicos da transação; dinheiro sempre como `MoneyProps` (string decimal). */
export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  money: MoneyProps;
  resultBalance: MoneyProps | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: string | null;
  attempts: number;
  createdAt: string;
  processedAt: string | null;
}

export function toTransactionView(tx: WagerTransaction): WagerTransactionView {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    status: tx.status,
    money: tx.money.toJSON(),
    resultBalance: tx.resultBalance?.toJSON() ?? null,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    failureCode: tx.failureCode ?? null,
    attempts: tx.attempts,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}

export class WagerQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(id: string): Promise<WagerTransactionView | null> {
    const tx = await this.uow.run((s) => s.transactions.findById(id));
    return tx ? toTransactionView(tx) : null;
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView | null> {
    const tx = await this.uow.run((s) => s.transactions.findByExternalId(providerId, externalTransactionId));
    return tx ? toTransactionView(tx) : null;
  }
}
