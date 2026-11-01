import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import type { UnitOfWork } from "../ports/unit-of-work";
import { WagerTransactionRejected } from "../../domain/events/events";
import { WagerTransactionStatus } from "../../domain/wagering/enums";
import { FailureCode } from "../../domain/wagering/failure-code";
import { WagerEngine } from "./wager-engine";

export interface ReprocessOptions {
  /** Tentativas antes de rejeitar com REFERENCE_NOT_FOUND (Design §15: 10 por padrão). */
  maxAttempts: number;
}

const BATCH_SIZE = 20;
/** Lease do claim (Design §15): a linha volta a ser elegível em 30 s se o worker morrer. */
const LEASE_SECONDS = 30;

/**
 * Reprocessa transações PENDING_REFERENCE (Design §15). Cada item roda em sua própria transação:
 * wallet travada primeiro, depois a transação; só então reexecuta a lógica do motor.
 */
export class ReprocessPendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly engine: WagerEngine,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: ReprocessOptions,
  ) {}

  /**
   * Um ciclo: claim de até 20 linhas (commit imediato) e processamento item a item.
   * `shouldStop` é consultado entre itens: o shutdown termina o item atual e devolve o resto ao lease.
   * Devolve o número de linhas reivindicadas.
   */
  async tick(shouldStop: () => boolean = () => false): Promise<number> {
    const now = this.clock.now();
    const claimed = await this.uow.run((scope) =>
      scope.transactions.claimDuePending(BATCH_SIZE, LEASE_SECONDS, now),
    );
    for (const item of claimed) {
      if (shouldStop()) break;
      await this.processOne(item.id, item.walletId);
    }
    return claimed.length;
  }

  /** Um item, em uma transação. Retorna false se pulou (wallet ausente ou status já mudou). */
  async processOne(id: string, walletId: string): Promise<boolean> {
    return this.uow.run(async (scope) => {
      // 1. Wallet primeiro; 2. transação. Mesma ordem do passo 10 do Design §8: sem deadlock.
      const wallet = await scope.wallets.lockForUpdate(walletId);
      if (!wallet) return false;
      const tx = await scope.transactions.lockById(id);
      // 3. Confirma o estado depois do lock: outro worker ou o caso síncrono pode já ter resolvido.
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return false;

      const now = this.clock.now();
      const seed = { correlationId: this.ids.next(), causationId: tx.id };

      // 4. Esgotou o limite: rejeita com REFERENCE_NOT_FOUND e avisa os dependentes.
      if (tx.attempts >= this.options.maxAttempts) {
        tx.reject(FailureCode.ReferenceNotFound, wallet.balance, now);
        await scope.transactions.update(tx);
        await this.engine.emit(scope, seed, now, (ctx) =>
          WagerTransactionRejected.from(
            {
              transactionId: tx.id,
              providerId: tx.providerId,
              externalTransactionId: tx.externalTransactionId,
              walletId: tx.walletId,
              kind: tx.kind,
              failureCode: FailureCode.ReferenceNotFound,
            },
            ctx,
          ),
        );
        await scope.transactions.markDependentsDue(tx.providerId, tx.externalTransactionId, now);
        return true;
      }

      // 5. Reexecuta a partir do passo 7 da seção 8 (o motor decide: aplica, rejeita ou mantém pendente).
      await this.engine.resolveAndApply(scope, wallet, tx, seed);
      return true;
    });
  }
}
