import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiBody, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { InvalidPayloadError, NotFoundError } from "../../application/errors";
import { CreateWallet, type WalletView } from "../../application/wallet/create-wallet";
import {
  MAX_LEDGER_LIMIT,
  WalletQueries,
  type LedgerPage,
} from "../../application/wallet/wallet-queries";
import { ReconcileWallet, type ReconciliationView } from "../../application/wallet/reconcile-wallet";
import { decodeCursor, encodeCursor } from "./cursor";
import {
  CreateWalletBodyDto,
  ErrorResponseDto,
  LedgerPageDto,
  ReconciliationDto,
  WalletDto,
} from "./openapi";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createWalletBody = z.strictObject({
  playerId: z.string().regex(UUID),
  // Validado por Money.from no caso de uso: amount não-string vira INVALID_MONEY.
  initialBalance: z.strictObject({ amount: z.unknown(), currency: z.unknown() }),
});

@ApiTags("wallets")
@Controller("wallets")
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly queries: WalletQueries,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: "Cria a wallet de um jogador numa moeda",
    description: "Saldo inicial maior que zero gera a transação `OPENING` e o lançamento `CREDIT` na mesma transação SQL.",
  })
  @ApiHeader({ name: "X-Correlation-Id", required: false, description: "Gerado pelo servidor se ausente." })
  @ApiBody({ type: CreateWalletBodyDto })
  @ApiResponse({ status: 201, type: WalletDto })
  @ApiResponse({ status: 400, description: "Payload ou valor monetário inválido.", type: ErrorResponseDto })
  @ApiResponse({ status: 409, description: "`WALLET_ALREADY_EXISTS`: mesmo `playerId` e moeda.", type: ErrorResponseDto })
  @ApiResponse({ status: 503, description: "Falha transitória de infraestrutura.", type: ErrorResponseDto })
  async create(
    @Body() body: unknown,
    @Headers("x-correlation-id") correlationId?: string,
  ): Promise<WalletView> {
    const parsed = createWalletBody.safeParse(body);
    if (!parsed.success) {
      throw new InvalidPayloadError(
        `invalid payload: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`,
      );
    }
    const { playerId, initialBalance } = parsed.data;
    return this.createWallet.execute(
      {
        playerId,
        initialBalance: { amount: initialBalance.amount as string, currency: initialBalance.currency as string },
      },
      { correlationId: correlationId ?? randomUUID() },
    );
  }

  @Get(":walletId")
  @ApiOperation({ summary: "Consulta saldo e versão da wallet" })
  @ApiParam({ name: "walletId", description: "UUID da wallet" })
  @ApiResponse({ status: 200, type: WalletDto })
  @ApiResponse({ status: 400, description: "`walletId` não é UUID.", type: ErrorResponseDto })
  @ApiResponse({ status: 404, description: "Wallet não encontrada.", type: ErrorResponseDto })
  async get(@Param("walletId", ParseUUIDPipe) walletId: string): Promise<WalletView> {
    const wallet = await this.queries.get(walletId);
    if (!wallet) throw new NotFoundError("wallet not found");
    return wallet;
  }

  @Get(":walletId/ledger")
  @ApiOperation({ summary: "Lançamentos do ledger em ordem de `seq`, com paginação por cursor" })
  @ApiParam({ name: "walletId", description: "UUID da wallet" })
  @ApiQuery({ name: "cursor", required: false, description: "`nextCursor` da página anterior." })
  @ApiQuery({ name: "limit", required: false, description: "Inteiro positivo; teto de 200.", example: 50 })
  @ApiResponse({ status: 200, type: LedgerPageDto })
  @ApiResponse({ status: 400, description: "`limit` ou `cursor` inválido.", type: ErrorResponseDto })
  @ApiResponse({ status: 404, description: "Wallet não encontrada.", type: ErrorResponseDto })
  async ledger(
    @Param("walletId", ParseUUIDPipe) walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<{ items: LedgerPage["items"]; nextCursor: string | null }> {
    const pageSize = parseLimit(limit);
    const afterSeq = cursor !== undefined ? decodeCursor(cursor) : undefined;
    const page = await this.queries.ledger(walletId, afterSeq, pageSize);
    return {
      items: page.items,
      nextCursor: page.nextSeq !== null ? encodeCursor(page.nextSeq) : null,
    };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  @ApiOperation({
    summary: "Compara o saldo guardado com o ledger",
    description: "Não corrige nada: divergência é registrada em log e em métrica.",
  })
  @ApiParam({ name: "walletId", description: "UUID da wallet" })
  @ApiResponse({ status: 200, type: ReconciliationDto })
  @ApiResponse({ status: 400, description: "`walletId` não é UUID.", type: ErrorResponseDto })
  @ApiResponse({ status: 404, description: "Wallet não encontrada.", type: ErrorResponseDto })
  async reconcile(@Param("walletId", ParseUUIDPipe) walletId: string): Promise<ReconciliationView> {
    const view = await this.reconcileWallet.execute(walletId);
    if (!view) throw new NotFoundError("wallet not found");
    return view;
  }
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  if (!/^[1-9]\d*$/.test(raw)) throw new InvalidPayloadError("limit must be a positive integer");
  return Math.min(Number(raw), MAX_LEDGER_LIMIT);
}
