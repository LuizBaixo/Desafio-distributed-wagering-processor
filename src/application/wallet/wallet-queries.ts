import { NotFoundError } from "../errors";
import type { UnitOfWork } from "../ports/unit-of-work";
import type { MoneyProps } from "../../domain/money/money";
import type { WalletView } from "./create-wallet";

export interface LedgerEntryView {
  seq: string;
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  /** seq do último item quando há mais páginas; null na última. */
  nextSeq: bigint | null;
}

export const MAX_LEDGER_LIMIT = 200;

export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  /** Wallet por id, ou null. */
  async get(id: string): Promise<WalletView | null> {
    return this.uow.run(async (scope) => {
      const wallet = await scope.wallets.findById(id);
      if (!wallet) return null;
      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }

  /**
   * Página do ledger em ordem de seq, a partir de `afterSeq` (exclusivo). `limit` tem teto de 200.
   * Lança NotFoundError se a wallet não existir.
   */
  async ledger(walletId: string, afterSeq: bigint | undefined, limit = 50): Promise<LedgerPage> {
    const pageSize = Math.min(limit, MAX_LEDGER_LIMIT);
    return this.uow.run(async (scope) => {
      const wallet = await scope.wallets.findById(walletId);
      if (!wallet) throw new NotFoundError("wallet not found");

      // Busca uma linha a mais para saber se existe próxima página.
      const rows = await scope.ledger.list(walletId, afterSeq, pageSize + 1);
      const hasMore = rows.length > pageSize;
      const page = rows.slice(0, pageSize);
      const items: LedgerEntryView[] = page.map((e) => ({
        seq: (e.seq ?? 0n).toString(),
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        createdAt: e.createdAt.toISOString(),
      }));
      const last = page[page.length - 1];
      return {
        items,
        nextSeq: hasMore && last?.seq !== undefined ? last.seq : null,
      };
    });
  }
}
