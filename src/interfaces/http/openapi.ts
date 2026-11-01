import type { INestApplication } from "@nestjs/common";
import { ApiProperty, DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

/**
 * Documentação OpenAPI servida em `/docs` (UI) e `/docs-json`.
 * Os DTOs abaixo só documentam o contrato: a validação continua nos controllers e nos casos de uso.
 * Dinheiro é sempre string decimal com 2 casas, nunca number.
 */

export const OPENAPI_PATH = "docs";

export function setupOpenApi(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("Wagering processor")
      .setDescription(
        "Processa transações de aposta (BET, WIN, LOSS, REFUND, ROLLBACK) por HTTP e SQS. " +
          "Dinheiro é sempre `{ amount: \"25.00\", currency: \"BRL\" }`.",
      )
      .setVersion("0.1.0")
      .build(),
  );
  SwaggerModule.setup(OPENAPI_PATH, app, document, { jsonDocumentUrl: `${OPENAPI_PATH}-json` });
}

export class MoneyDto {
  @ApiProperty({ type: "string", pattern: "^\\d+\\.\\d{2}$", example: "25.00" })
  amount!: string;

  @ApiProperty({ example: "BRL" })
  currency!: string;
}

export class ErrorBodyDto {
  @ApiProperty({ example: "INVALID_PAYLOAD" })
  code!: string;

  @ApiProperty({ example: "invalid payload: money.amount: must be a decimal string with 2 places" })
  message!: string;
}

export class ErrorResponseDto {
  @ApiProperty({ type: () => ErrorBodyDto })
  error!: ErrorBodyDto;
}

export class CreateWalletBodyDto {
  @ApiProperty({ format: "uuid", example: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1" })
  playerId!: string;

  @ApiProperty({ type: () => MoneyDto, description: "Saldo inicial. Zero não gera transação OPENING." })
  initialBalance!: MoneyDto;
}

export class WalletDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ format: "uuid" })
  playerId!: string;

  @ApiProperty({ type: () => MoneyDto })
  balance!: MoneyDto;

  @ApiProperty({ example: 1 })
  version!: number;
}

export class LedgerEntryDto {
  @ApiProperty({ type: "string", example: "42", description: "Sequência do lançamento (bigint serializado)." })
  seq!: string;

  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ format: "uuid" })
  transactionId!: string;

  @ApiProperty({ enum: ["DEBIT", "CREDIT"] })
  direction!: string;

  @ApiProperty({ type: () => MoneyDto })
  money!: MoneyDto;

  @ApiProperty({ type: () => MoneyDto })
  balanceBefore!: MoneyDto;

  @ApiProperty({ type: () => MoneyDto })
  balanceAfter!: MoneyDto;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;
}

export class LedgerPageDto {
  @ApiProperty({ type: () => [LedgerEntryDto] })
  items!: LedgerEntryDto[];

  @ApiProperty({ type: "string", nullable: true, example: "djE6NDI" })
  nextCursor!: string | null;
}

export class ReconciliationDto {
  @ApiProperty({ format: "uuid" })
  walletId!: string;

  @ApiProperty({ type: () => MoneyDto })
  storedBalance!: MoneyDto;

  @ApiProperty({ type: () => MoneyDto })
  calculatedBalance!: MoneyDto;

  @ApiProperty({ type: () => MoneyDto })
  difference!: MoneyDto;

  @ApiProperty()
  consistent!: boolean;

  @ApiProperty({ example: 12 })
  checkedEntries!: number;
}

export class WagerCommandBodyDto {
  @ApiProperty({ example: "provider-a" })
  providerId!: string;

  @ApiProperty({ example: "transaction-123" })
  externalTransactionId!: string;

  @ApiProperty({ required: false, description: "Obrigatório para REFUND e ROLLBACK." })
  referenceExternalTransactionId?: string;

  @ApiProperty({ format: "uuid" })
  playerId!: string;

  @ApiProperty({ format: "uuid" })
  walletId!: string;

  @ApiProperty({ example: "round-987" })
  roundId!: string;

  @ApiProperty({ example: "fortune-chimp" })
  gameId!: string;

  @ApiProperty({ enum: ["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"] })
  kind!: string;

  @ApiProperty({ type: () => MoneyDto })
  money!: MoneyDto;
}

export class WagerResultDto {
  @ApiProperty({ format: "uuid", nullable: true })
  transactionId!: string | null;

  @ApiProperty({ enum: ["PENDING", "PENDING_REFERENCE", "PROCESSED", "REJECTED", "FAILED"] })
  status!: string;

  @ApiProperty({ type: () => MoneyDto, nullable: true })
  balance!: MoneyDto | null;

  @ApiProperty({ nullable: true, example: "INSUFFICIENT_FUNDS" })
  failureCode!: string | null;

  @ApiProperty({ description: "true quando a resposta repete uma submissão anterior com a mesma Idempotency-Key." })
  idempotentReplay!: boolean;
}

export class WagerTransactionDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty()
  providerId!: string;

  @ApiProperty()
  externalTransactionId!: string;

  @ApiProperty()
  idempotencyKey!: string;

  @ApiProperty({ format: "uuid" })
  walletId!: string;

  @ApiProperty({ format: "uuid" })
  playerId!: string;

  @ApiProperty()
  roundId!: string;

  @ApiProperty()
  gameId!: string;

  @ApiProperty({ enum: ["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"] })
  kind!: string;

  @ApiProperty({ enum: ["PENDING", "PENDING_REFERENCE", "PROCESSED", "REJECTED", "FAILED"] })
  status!: string;

  @ApiProperty({ type: () => MoneyDto })
  money!: MoneyDto;

  @ApiProperty({ type: () => MoneyDto, nullable: true })
  resultBalance!: MoneyDto | null;

  @ApiProperty({ nullable: true })
  referenceExternalTransactionId!: string | null;

  @ApiProperty({ format: "uuid", nullable: true })
  referenceTransactionId!: string | null;

  @ApiProperty({ nullable: true })
  failureCode!: string | null;

  @ApiProperty({ example: 1 })
  attempts!: number;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;

  @ApiProperty({ format: "date-time", nullable: true })
  processedAt!: string | null;
}

export class HealthDto {
  @ApiProperty({ example: "ok" })
  status!: string;
}

export class NotReadyDto {
  @ApiProperty({ type: () => ErrorBodyDto, example: { code: "SHUTTING_DOWN", message: "shutting down" } })
  error!: ErrorBodyDto;
}
