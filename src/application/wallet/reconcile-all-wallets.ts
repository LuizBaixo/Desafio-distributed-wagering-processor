import type { Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { Metrics } from "../ports/metrics";
import type { UnitOfWork } from "../ports/unit-of-work";
import type { ReconcileWallet } from "./reconcile-wallet";

export interface ReconcileAllResult {
  checked: number;
  inconsistent: string[];
}

const PAGE_SIZE = 100;

/**
 * Percorre todas as wallets, em páginas de ids, e reconcilia cada uma na própria transação (o `FOR SHARE`
 * de `ReconcileWallet` dura só o tempo de uma wallet). Não corrige nada: divergência vira log, métrica e
 * entrada em `inconsistent`.
 */
export class ReconcileAllWallets {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly reconcile: ReconcileWallet,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async run(shouldStop: () => boolean = () => false): Promise<ReconcileAllResult> {
    let checked = 0;
    const inconsistent: string[] = [];
    let after: string | undefined;

    for (;;) {
      if (shouldStop()) break;
      const ids = await this.uow.run((scope) => scope.wallets.listIdsAfter(after, PAGE_SIZE));
      if (ids.length === 0) break;
      for (const id of ids) {
        if (shouldStop()) break;
        const view = await this.reconcile.execute(id);
        if (view === null) continue; // wallet sumiu entre a listagem e a conferência
        checked++;
        if (!view.consistent) inconsistent.push(id);
      }
      after = ids[ids.length - 1];
      if (ids.length < PAGE_SIZE) break;
    }

    this.metrics.reconciliationRun(checked, this.clock.now().getTime() / 1000);
    this.logger.info({ checked, inconsistent: inconsistent.length }, "reconciliation run finished");
    return { checked, inconsistent };
  }
}
