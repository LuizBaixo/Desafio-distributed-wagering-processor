import type { Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { Metrics } from "../ports/metrics";
import type { UnitOfWork } from "../ports/unit-of-work";
import type { ReconcileWallet, ReconciliationView } from "./reconcile-wallet";

export interface ReconcileAllResult {
  checked: number;
  inconsistent: string[];
  /** Wallets cuja conferência lançou erro. Não entram em `checked`. */
  errors: string[];
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
    const errors: string[] = [];
    let after: string | undefined;
    let interrupted = false;

    for (;;) {
      if (shouldStop()) {
        interrupted = true;
        break;
      }
      const ids = await this.uow.run((scope) => scope.wallets.listIdsAfter(after, PAGE_SIZE));
      if (ids.length === 0) break;
      for (const id of ids) {
        if (shouldStop()) {
          interrupted = true;
          break;
        }
        let view: ReconciliationView | null;
        try {
          view = await this.reconcile.execute(id);
        } catch (err) {
          // Uma wallet com erro (ex.: lock_timeout) não aborta a rodada: registra e segue.
          errors.push(id);
          this.metrics.reconciliationError();
          const e = err instanceof Error ? err : undefined;
          this.logger.error({ walletId: id, errorName: e?.name ?? "UnknownError" }, "reconciliation wallet failed");
          continue;
        }
        if (view === null) continue; // wallet sumiu entre a listagem e a conferência
        checked++;
        if (!view.consistent) inconsistent.push(id);
      }
      if (interrupted) break;
      after = ids[ids.length - 1];
      if (ids.length < PAGE_SIZE) break;
    }

    if (interrupted) {
      // Rodada parcial: não grava métricas de execução completa (runs, checked, última execução).
      this.logger.warn({ checked, inconsistent: inconsistent.length, errors: errors.length }, "reconciliation run interrupted");
      return { checked, inconsistent, errors };
    }
    this.metrics.reconciliationRun(checked, this.clock.now().getTime() / 1000);
    this.logger.info({ checked, inconsistent: inconsistent.length, errors: errors.length }, "reconciliation run finished");
    return { checked, inconsistent, errors };
  }
}
