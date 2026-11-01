import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Res, UseGuards } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { NotFoundError } from "../../application/errors";
import { parseWagerCommand } from "../../application/wagering/wager-command";
import type { WagerOutcome } from "../../application/wagering/wager-outcome";
import { SubmitWagerTransaction } from "../../application/wagering/submit-wager-transaction";
import { WagerQueries, type WagerTransactionView } from "../../application/wagering/wager-queries";
import { AuthGuard } from "./auth.guard";

/** Subconjunto de Express Response usado aqui; evita depender de @types/express. */
interface StatusSetter {
  status(code: number): unknown;
}

const CONFLICT_MESSAGES: Record<string, string> = {
  IDEMPOTENCY_CONFLICT: "the Idempotency-Key was already used with a different payload",
  EXTERNAL_ID_CONFLICT: "externalTransactionId already exists under another Idempotency-Key; use a new externalTransactionId to retry",
};

/**
 * Status HTTP (Design §12): processada 200, pendente 202, rejeitada por regra 422, conflito 409.
 * Replay mantém o status da transação original; `idempotentReplay` distingue.
 */
function respond(outcome: WagerOutcome, res: StatusSetter): unknown {
  switch (outcome.kind) {
    case "processed":
      res.status(200);
      return outcome.view;
    case "pending":
      res.status(202);
      return outcome.view;
    case "rejected":
      res.status(422);
      return outcome.view;
    case "conflict":
      res.status(409);
      return { error: { code: outcome.code, message: CONFLICT_MESSAGES[outcome.code] } };
  }
}

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransaction,
    private readonly queries: WagerQueries,
  ) {}

  @Post("wagering/transactions")
  async submitTransaction(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Res({ passthrough: true }) res: StatusSetter,
  ): Promise<unknown> {
    const cmd = parseWagerCommand(body, idempotencyKey);
    const result = await this.submit.execute(cmd, { correlationId: correlationId ?? randomUUID() });
    if (result.kind === "duplicateMessage") {
      // Só existe com inbox (SQS); o HTTP nunca passa `inbox`.
      throw new Error("unexpected duplicateMessage on HTTP");
    }
    return respond(result, res);
  }

  @Get("wagering/transactions/:transactionId")
  async getById(@Param("transactionId", ParseUUIDPipe) transactionId: string): Promise<WagerTransactionView> {
    const view = await this.queries.byId(transactionId);
    if (!view) throw new NotFoundError("transaction not found");
    return view;
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    const view = await this.queries.byExternalId(providerId, externalTransactionId);
    if (!view) throw new NotFoundError("transaction not found");
    return view;
  }
}
