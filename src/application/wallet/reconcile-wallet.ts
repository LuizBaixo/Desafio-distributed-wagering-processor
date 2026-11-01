import type { Logger } from "../ports/logger";
import type { Metrics } from "../ports/metrics";
import type { UnitOfWork } from "../ports/unit-of-work";
import type { MoneyProps } from "../../domain/money/money";

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compara o saldo guardado com o ledger. Não corrige nada: divergência é logada,
 * contada em métrica e sinalizada na resposta (README §9).
 */
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  async execute(walletId: string): Promise<ReconciliationView | null> {
    const view = await this.uow.run(async (scope): Promise<ReconciliationView | null> => {
      // FOR SHARE: impede alteração concorrente de saldo durante a comparação.
      const wallet = await scope.wallets.lockForShare(walletId);
      if (!wallet) return null;

      const totals = await scope.ledger.totals(walletId);
      const stored = wallet.balance;
      const calculated = totals.credits.subtract(totals.debits);
      const difference = stored.subtract(calculated);
      // Também confere com o balance_after do último lançamento; sem lançamentos, o saldo deve ser zero.
      const lastMatches = totals.lastBalanceAfter
        ? stored.equals(totals.lastBalanceAfter)
        : stored.isZero();

      return {
        walletId,
        storedBalance: stored.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero() && lastMatches,
        checkedEntries: totals.count,
      };
    });

    if (view && !view.consistent) {
      this.logger.error({ walletId, difference: view.difference.amount }, "reconciliation mismatch");
      this.metrics.reconciliationMismatch();
    }
    return view;
  }
}
