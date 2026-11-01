import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Res, UseGuards } from "@nestjs/common";
import { ApiBody, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { randomUUID } from "node:crypto";
import { NotFoundError } from "../../application/errors";
import { parseWagerCommand } from "../../application/wagering/wager-command";
import type { WagerOutcome } from "../../application/wagering/wager-outcome";
import { SubmitWagerTransaction } from "../../application/wagering/submit-wager-transaction";
import { WagerQueries, type WagerTransactionView } from "../../application/wagering/wager-queries";
import { AuthGuard } from "./auth.guard";
import {
  ErrorResponseDto,
  WagerCommandBodyDto,
  WagerResultDto,
  WagerTransactionDto,
} from "./openapi";

/** Subconjunto de Express Response usado aqui; evita depender de @types/express. */
interface StatusSetter {
  status(code: number): unknown;
}

const CONFLICT_MESSAGES: Record<string, string> = {
  IDEMPOTENCY_CONFLICT: "the Idempotency-Key was already used with a different payload",
  EXTERNAL_ID_CONFLICT: "externalTransactionId already exists under another Idempotency-Key; use a new externalTransactionId to retry",
};

/**
 * Status HTTP (Design §12): processada 200, pendente 202, rejeitada por regra 422, conflito 409, FAILED 500.
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
    case "failed":
      // FAILED é erro permanente de infraestrutura já gravado: 500, mas com o corpo da view (traz `status`).
      res.status(500);
      return outcome.view;
    case "conflict":
      res.status(409);
      return { error: { code: outcome.code, message: CONFLICT_MESSAGES[outcome.code] } };
  }
}

@ApiTags("wagering")
@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransaction,
    private readonly queries: WagerQueries,
  ) {}

  @Post("wagering/transactions")
  @ApiOperation({
    summary: "Submete uma transação de aposta",
    description:
      "Idempotente pela `Idempotency-Key`. Repetir a mesma requisição devolve o resultado original com `idempotentReplay: true`.",
  })
  @ApiHeader({ name: "Idempotency-Key", required: true, example: "provider-a:transaction-123" })
  @ApiHeader({ name: "X-Correlation-Id", required: false, description: "Gerado pelo servidor se ausente." })
  @ApiBody({ type: WagerCommandBodyDto })
  @ApiResponse({ status: 200, description: "Processada (`PROCESSED`).", type: WagerResultDto })
  @ApiResponse({ status: 202, description: "Pendente de referência (`PENDING_REFERENCE`).", type: WagerResultDto })
  @ApiResponse({ status: 400, description: "Payload inválido.", type: ErrorResponseDto })
  @ApiResponse({ status: 409, description: "`IDEMPOTENCY_CONFLICT` ou `EXTERNAL_ID_CONFLICT`.", type: ErrorResponseDto })
  @ApiResponse({ status: 422, description: "Rejeitada por regra de negócio (com `failureCode`).", type: WagerResultDto })
  @ApiResponse({
    status: 500,
    description: "Transação `FAILED` (`INFRA_PERMANENT`) já gravada para esta key. Não reenviar; investigar.",
    type: WagerResultDto,
  })
  @ApiResponse({
    status: 503,
    description: "Falha transitória de infraestrutura. Responde `Retry-After`.",
    type: ErrorResponseDto,
    headers: { "Retry-After": { description: "Segundos até nova tentativa.", schema: { type: "integer", example: 1 } } },
  })
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
  @ApiOperation({ summary: "Consulta uma transação pelo id interno" })
  @ApiParam({ name: "transactionId", description: "UUID da transação", example: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2" })
  @ApiResponse({ status: 200, type: WagerTransactionDto })
  @ApiResponse({ status: 400, description: "`transactionId` não é UUID.", type: ErrorResponseDto })
  @ApiResponse({ status: 404, description: "Transação não encontrada.", type: ErrorResponseDto })
  async getById(@Param("transactionId", ParseUUIDPipe) transactionId: string): Promise<WagerTransactionView> {
    const view = await this.queries.byId(transactionId);
    if (!view) throw new NotFoundError("transaction not found");
    return view;
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  @ApiOperation({ summary: "Consulta uma transação pelo id externo do provedor" })
  @ApiParam({ name: "providerId", example: "provider-a" })
  @ApiParam({ name: "externalTransactionId", example: "transaction-123" })
  @ApiResponse({ status: 200, type: WagerTransactionDto })
  @ApiResponse({ status: 404, description: "Transação não encontrada.", type: ErrorResponseDto })
  async getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    const view = await this.queries.byExternalId(providerId, externalTransactionId);
    if (!view) throw new NotFoundError("transaction not found");
    return view;
  }
}
