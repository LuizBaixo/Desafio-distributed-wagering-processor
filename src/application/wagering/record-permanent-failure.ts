import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import type { Logger } from "../ports/logger";
import type { Metrics } from "../ports/metrics";
import type { UnitOfWork } from "../ports/unit-of-work";
import { wagerPayloadHash } from "../idempotency/payload-hash";
import { WagerTransactionRejected } from "../../domain/events/events";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import { Money } from "../../domain/money/money";
import { FailureCode } from "../../domain/wagering/failure-code";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { WagerCommand } from "./wager-command";
import type { WagerEngine } from "./wager-engine";

export interface PermanentFailureContext {
  correlationId: string;
  causationId?: string;
  /** Id da mensagem de entrada; entra na inbox junto com `consumerName`. */
  messageId: string;
  consumerName: string;
}

/** `no-wallet`: sem wallet a FK impede a linha; `exists`: a key (ou o id externo, ou a mensagem) já tem registro. */
export type PermanentFailureResult = "recorded" | "exists" | "no-wallet";

/** 23505 vindo do driver, direto ou encadeado em `cause`. Estrutural: esta camada não importa infraestrutura. */
function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; typeof cur === "object" && cur !== null && depth < 4; depth++) {
    const err = cur as { code?: unknown; cause?: unknown };
    if (err.code === "23505") return true;
    cur = err.cause;
  }
  return false;
}

/**
 * Grava a transação como `FAILED` (`INFRA_PERMANENT`) quando o consumidor desiste de uma mensagem por erro
 * inesperado. Assim o provedor que reenviar a mesma key recebe o estado gravado, e o evento de rejeição sai
 * pela outbox. Nunca sobrescreve registro existente e nunca toca no saldo.
 */
export class RecordPermanentFailure {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly engine: WagerEngine,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async execute(cmd: WagerCommand, ctx: PermanentFailureContext): Promise<PermanentFailureResult> {
    let result: PermanentFailureResult;
    try {
      result = await this.uow.run(async (scope): Promise<PermanentFailureResult> => {
        const now = this.clock.now();

        if ((await scope.wallets.findById(cmd.walletId)) === null) return "no-wallet";
        if ((await scope.transactions.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey)) !== null) return "exists";
        if ((await scope.transactions.findByExternalId(cmd.providerId, cmd.externalTransactionId)) !== null) return "exists";

        const payloadHash = wagerPayloadHash(cmd);
        const message = InboxMessage.receive({ consumerName: ctx.consumerName, messageId: ctx.messageId, payloadHash, receivedAt: now });
        message.markProcessed(now);
        const received = await scope.inbox.tryReceive(message);
        if (received !== "new") return "exists";

        const tx = WagerTransaction.create({
          id: this.ids.next(),
          providerId: cmd.providerId,
          externalTransactionId: cmd.externalTransactionId,
          idempotencyKey: cmd.idempotencyKey,
          payloadHash,
          walletId: cmd.walletId,
          playerId: cmd.playerId,
          roundId: cmd.roundId,
          gameId: cmd.gameId,
          kind: cmd.kind,
          money: Money.from(cmd.money),
          ...(cmd.referenceExternalTransactionId !== undefined
            ? { referenceExternalTransactionId: cmd.referenceExternalTransactionId }
            : {}),
          createdAt: now,
        });
        tx.fail(FailureCode.InfraPermanent, now);
        await scope.transactions.insert(tx);
        await this.engine.emit(scope, ctx, now, (eventCtx) =>
          WagerTransactionRejected.from(
            {
              transactionId: tx.id,
              providerId: tx.providerId,
              externalTransactionId: tx.externalTransactionId,
              walletId: tx.walletId,
              kind: tx.kind,
              failureCode: FailureCode.InfraPermanent,
            },
            eventCtx,
          ),
        );
        return "recorded";
      });
    } catch (e) {
      // Corrida com outra execução (mesma key, id externo ou mensagem): o rollback desfez tudo; já existe registro.
      if (isUniqueViolation(e)) return "exists";
      throw e;
    }

    if (result === "recorded") {
      this.metrics.transaction("FAILED", cmd.kind);
      this.logger.info(
        {
          kind: cmd.kind,
          source: "sqs",
          correlationId: ctx.correlationId,
          messageId: ctx.messageId,
          walletId: cmd.walletId,
          providerId: cmd.providerId,
          status: "FAILED",
          failureCode: FailureCode.InfraPermanent,
        },
        "wager failed permanently",
      );
    }
    return result;
  }
}
