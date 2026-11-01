import { isLockConflict } from "../errors";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import type { Logger } from "../ports/logger";
import type { Metrics } from "../ports/metrics";
import type { TransactionScope, UnitOfWork } from "../ports/unit-of-work";
import { wagerPayloadHash } from "../idempotency/payload-hash";
import { WagerTransactionRejected } from "../../domain/events/events";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import { Money } from "../../domain/money/money";
import { WagerTransactionStatus } from "../../domain/wagering/enums";
import { FailureCode } from "../../domain/wagering/failure-code";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { WagerCommand } from "./wager-command";
import type { EventContextSeed, WagerEngine } from "./wager-engine";
import type { WagerOutcome, WagerResultView } from "./wager-outcome";

export interface SubmitContext extends EventContextSeed {
  /** Presente quando a entrada é SQS: a inbox entra na mesma transação. */
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

/** `payloadMismatch`: o messageId já tinha sido recebido com outro payload_hash (ack mantido, mas sinalizado). */
export type SubmitResult = WagerOutcome | { kind: "duplicateMessage"; payloadMismatch?: boolean };

/** Constraints cuja violação é uma corrida legítima de idempotência (Design §8, nota final). */
const RACE_CONSTRAINTS = ["wager_tx_provider_idempotency_uq", "wager_tx_provider_external_uq"];
const MAX_ATTEMPTS = 2;

/** 23505 numa das constraints de corrida. Estrutural: o erro vem do driver, a camada não importa infraestrutura. */
function isIdempotencyRace(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; typeof cur === "object" && cur !== null && depth < 4; depth++) {
    const err = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (err.code === "23505" && typeof err.constraint === "string" && RACE_CONSTRAINTS.includes(err.constraint)) {
      return true;
    }
    cur = err.cause;
  }
  return false;
}

export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly engine: WagerEngine,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async execute(cmd: WagerCommand, ctx: SubmitContext): Promise<SubmitResult> {
    const startedAt = performance.now();
    const source = ctx.inbox ? "sqs" : "http";

    let result: SubmitResult | undefined;
    for (let attempt = 1; result === undefined; attempt++) {
      try {
        result = await this.uow.run((scope) => this.processOnce(scope, cmd, ctx));
      } catch (e) {
        // Corrida entre wallets diferentes com a mesma key (a wallet travada não as serializa):
        // o rollback desfez tudo, inclusive a inbox; reler agora cai em replay ou conflito.
        if (!isIdempotencyRace(e) || attempt >= MAX_ATTEMPTS) {
          if (isLockConflict(e)) this.metrics.lockConflict();
          throw e;
        }
      }
    }

    this.record(result, cmd, source);
    if (result.kind === "duplicateMessage" && result.payloadMismatch) this.warnPayloadMismatch(cmd, ctx);
    this.logOutcome(result, cmd, ctx, source);
    this.metrics.observeProcessing((performance.now() - startedAt) / 1000, source);
    return result;
  }

  private async processOnce(scope: TransactionScope, cmd: WagerCommand, ctx: SubmitContext): Promise<SubmitResult> {
    const now = this.clock.now();

    // Inbox primeiro (deduplica a entrega): duplicada encerra sem tocar em mais nada.
    if (ctx.inbox) {
      const received = await scope.inbox.tryReceive(
        InboxMessage.receive({ ...ctx.inbox, receivedAt: now }),
      );
      if (received === "duplicate") return { kind: "duplicateMessage" };
      if (received === "conflict") return { kind: "duplicateMessage", payloadMismatch: true };
    }

    // Passo 4: lock da wallet ANTES de qualquer leitura de idempotência.
    const wallet = await scope.wallets.lockForUpdate(cmd.walletId);
    if (wallet === null) {
      // Sem wallet não há como gravar a transação (FK): rejeição auditada só por evento.
      await this.enqueueRejection(scope, cmd, ctx, now, FailureCode.WalletNotFound);
      return {
        kind: "rejected",
        view: {
          transactionId: null,
          status: WagerTransactionStatus.Rejected,
          balance: null,
          failureCode: FailureCode.WalletNotFound,
          idempotentReplay: false,
        },
      };
    }

    // Passo 5: idempotência.
    const payloadHash = wagerPayloadHash(cmd);
    const byKey = await scope.transactions.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey);
    if (byKey !== null) {
      if (byKey.matchesPayload(payloadHash)) {
        // Replay: devolve o snapshot gravado (result_balance), nunca o saldo atual.
        return this.outcomeOf(this.engine.view(byKey, true));
      }
      await this.enqueueRejection(scope, cmd, ctx, now, FailureCode.IdempotencyConflict);
      return { kind: "conflict", code: "IDEMPOTENCY_CONFLICT" };
    }
    const byExternal = await scope.transactions.findByExternalId(cmd.providerId, cmd.externalTransactionId);
    if (byExternal !== null) {
      await this.enqueueRejection(scope, cmd, ctx, now, FailureCode.ExternalIdConflict);
      return { kind: "conflict", code: "EXTERNAL_ID_CONFLICT" };
    }

    // Passos 6 a 10.
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
    const view = await this.engine.resolveAndApply(scope, wallet, tx, ctx);
    return this.outcomeOf(view);
  }

  private async enqueueRejection(
    scope: TransactionScope,
    cmd: WagerCommand,
    ctx: SubmitContext,
    now: Date,
    failureCode: FailureCode,
  ): Promise<void> {
    await this.engine.emit(scope, ctx, now, (eventCtx) =>
      WagerTransactionRejected.from(
        {
          providerId: cmd.providerId,
          externalTransactionId: cmd.externalTransactionId,
          walletId: cmd.walletId,
          kind: cmd.kind,
          failureCode,
        },
        eventCtx,
      ),
    );
  }

  private outcomeOf(view: WagerResultView): WagerOutcome {
    switch (view.status) {
      case WagerTransactionStatus.Processed:
        return { kind: "processed", view };
      case WagerTransactionStatus.Rejected:
      case WagerTransactionStatus.Failed:
        return { kind: "rejected", view };
      default:
        return { kind: "pending", view };
    }
  }

  /** messageId repetido com payload diferente. Sem payload nem valores no log. */
  private warnPayloadMismatch(cmd: WagerCommand, ctx: SubmitContext): void {
    this.logger.warn(
      {
        source: "sqs",
        correlationId: ctx.correlationId,
        messageId: ctx.inbox?.messageId,
        walletId: cmd.walletId,
        providerId: cmd.providerId,
      },
      "inbox messageId repeated with a different payload hash; acknowledged as duplicate",
    );
  }

  /** Uma linha info por resultado, depois do commit. Nunca loga valores monetários nem o payload. */
  private logOutcome(result: SubmitResult, cmd: WagerCommand, ctx: SubmitContext, source: "http" | "sqs"): void {
    const base = {
      kind: cmd.kind,
      source,
      correlationId: ctx.correlationId,
      ...(ctx.inbox ? { messageId: ctx.inbox.messageId } : {}),
      walletId: cmd.walletId,
      providerId: cmd.providerId,
    };
    switch (result.kind) {
      case "duplicateMessage":
        this.logger.info(
          { ...base, transactionId: null, status: "DUPLICATE_MESSAGE", failureCode: null, idempotentReplay: false },
          "wager outcome",
        );
        return;
      case "conflict":
        this.logger.info(
          { ...base, transactionId: null, status: "CONFLICT", failureCode: result.code, idempotentReplay: false },
          "wager outcome",
        );
        return;
      default:
        this.logger.info(
          {
            ...base,
            transactionId: result.view.transactionId,
            status: result.view.status,
            failureCode: result.view.failureCode,
            idempotentReplay: result.view.idempotentReplay,
          },
          "wager outcome",
        );
    }
  }

  /** Métricas só depois do commit, para não contar tentativa revertida. */
  private record(result: SubmitResult, cmd: WagerCommand, source: "http" | "sqs"): void {
    switch (result.kind) {
      case "duplicateMessage":
        this.metrics.duplicate("inbox", result.payloadMismatch ? "conflict" : "message");
        return;
      case "conflict":
        this.metrics.duplicate(source, "conflict");
        return;
      default:
        if (result.view.idempotentReplay) this.metrics.duplicate(source, "replay");
        else this.metrics.transaction(result.view.status, cmd.kind);
    }
  }
}
