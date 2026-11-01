import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import type { TransactionScope } from "../ports/unit-of-work";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { EventContext, IntegrationEvent } from "../../domain/events/integration-event";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/events/events";
import { decideWager, type ReferenceLookup } from "../../domain/wagering/decide-wager";
import { LedgerDirection, WagerTransactionStatus } from "../../domain/wagering/enums";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WagerResultView } from "./wager-outcome";

export interface EventContextSeed {
  correlationId: string;
  causationId?: string;
}

const MAX_PENDING_BACKOFF_SECONDS = 60;

/**
 * Passos 7 a 10 do Design §8, compartilhados pelo caso de uso síncrono e pelo worker de pendentes.
 *
 * Pré-condições (do chamador): a wallet foi travada com `FOR UPDATE` nesta mesma transação SQL e
 * `tx` está em `PENDING` (nova, ainda não gravada) ou `PENDING_REFERENCE` (já gravada, reprocessamento).
 * O motor só escreve; commit e rollback são do `UnitOfWork`.
 */
export class WagerEngine {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async resolveAndApply(
    scope: TransactionScope,
    wallet: Wallet,
    tx: WagerTransaction,
    seed: EventContextSeed,
  ): Promise<WagerResultView> {
    const now = this.clock.now();
    const isNew = tx.status === WagerTransactionStatus.Pending;

    // Passo 7: resolver a referência (se houver).
    const lookup = await this.lookupReference(scope, tx);

    // Passos 6 a 8: decisão pura.
    const decision = decideWager(wallet, tx, lookup);

    switch (decision.type) {
      case "apply": {
        // Passo 8: o agregado muta saldo e devolve o lançamento; nada vai ao banco ainda.
        const expectedVersion = wallet.version;
        const movement = {
          money: tx.money,
          transactionId: tx.id,
          entryId: this.ids.next(),
          at: now,
        };
        const entry =
          decision.direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
        tx.markProcessed(decision.referenceTransactionId, wallet.balance, now);

        // Passo 9: gravar. A transação precede o lançamento por causa da FK ledger -> transação.
        await scope.wallets.saveBalance(wallet, expectedVersion);
        await this.persist(scope, tx, isNew);
        await scope.ledger.append(entry);
        await this.emit(scope, seed, now, (ctx) => WagerTransactionProcessed.from(tx, ctx));
        await this.emit(scope, seed, now, (ctx) => WalletBalanceChanged.from(wallet, entry, ctx));
        // Passo 10: destravar dependentes.
        await scope.transactions.markDependentsDue(tx.providerId, tx.externalTransactionId, now);
        return this.view(tx, false);
      }

      case "noop": {
        tx.markProcessed(decision.referenceTransactionId, wallet.balance, now);
        await this.persist(scope, tx, isNew);
        await this.emit(scope, seed, now, (ctx) => WagerTransactionProcessed.from(tx, ctx));
        await scope.transactions.markDependentsDue(tx.providerId, tx.externalTransactionId, now);
        return this.view(tx, false);
      }

      case "reject": {
        tx.reject(decision.code, wallet.balance, now);
        await this.persist(scope, tx, isNew);
        await this.emit(scope, seed, now, (ctx) =>
          WagerTransactionRejected.from(
            {
              transactionId: tx.id,
              providerId: tx.providerId,
              externalTransactionId: tx.externalTransactionId,
              walletId: tx.walletId,
              kind: tx.kind,
              failureCode: decision.code,
            },
            ctx,
          ),
        );
        return this.view(tx, false);
      }

      case "pendingReference": {
        // Backoff: now + min(2^attempts, 60)s, com attempts já contando esta tentativa.
        const attemptsAfter = isNew ? tx.attempts : tx.attempts + 1;
        const delaySeconds = Math.min(2 ** attemptsAfter, MAX_PENDING_BACKOFF_SECONDS);
        tx.markPendingReference(new Date(now.getTime() + delaySeconds * 1000));
        await this.persist(scope, tx, isNew);
        await this.emit(scope, seed, now, (ctx) => WagerTransactionPendingReference.from(tx, ctx));
        return this.view(tx, false);
      }
    }
  }

  /** Enfileira um evento na outbox, na transação corrente. */
  async emit<E extends IntegrationEvent<unknown>>(
    scope: TransactionScope,
    seed: EventContextSeed,
    now: Date,
    build: (ctx: EventContext) => E,
  ): Promise<void> {
    const ctx: EventContext = {
      eventId: this.ids.next(),
      correlationId: seed.correlationId,
      ...(seed.causationId !== undefined ? { causationId: seed.causationId } : {}),
      occurredAt: now,
    };
    await scope.outbox.enqueue(OutboxMessage.enqueue(build(ctx)));
  }

  /** Visão de resultado a partir de uma transação gravada (usada também no replay). */
  view(tx: WagerTransaction, idempotentReplay: boolean): WagerResultView {
    return {
      transactionId: tx.id,
      status: tx.status,
      balance: tx.resultBalance?.toJSON() ?? null,
      failureCode: tx.failureCode ?? null,
      idempotentReplay,
    };
  }

  private persist(scope: TransactionScope, tx: WagerTransaction, isNew: boolean): Promise<void> {
    return isNew ? scope.transactions.insert(tx) : scope.transactions.update(tx);
  }

  private async lookupReference(scope: TransactionScope, tx: WagerTransaction): Promise<ReferenceLookup> {
    const referenceExternalId = tx.referenceExternalTransactionId;
    if (referenceExternalId === undefined) return { state: "absent" };
    const found = await scope.transactions.findByExternalId(tx.providerId, referenceExternalId);
    if (found === null) return { state: "missing" };
    return { state: "found", tx: found, alreadyReversed: await scope.transactions.isReversed(found.id) };
  }
}
