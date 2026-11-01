import type { Pool } from "pg";
import type { WagerCommand } from "../../src/application/wagering/wager-command";
import { WagerTransactionKind } from "../../src/domain/wagering/enums";
import { ownerPool } from "./db";

const uuid = () => crypto.randomUUID();

/** Comando de aposta válido (BET de 25.00 BRL). `walletId` e `playerId` são UUIDs novos, salvo override. */
export function buildWagerCommand(overrides: Partial<WagerCommand> = {}): WagerCommand {
  const id = uuid();
  return {
    providerId: "provider-a",
    externalTransactionId: `ext-${id}`,
    idempotencyKey: `key-${id}`,
    playerId: uuid(),
    walletId: uuid(),
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: { amount: "25.00", currency: "BRL" },
    ...overrides,
  };
}

export interface DirectWallet {
  walletId: string;
  playerId: string;
  currency: string;
  balance: string;
}

/**
 * Cria wallet direto no banco (como owner), sem passar pela aplicação. Com saldo maior que zero,
 * grava também a transação OPENING e o lançamento CREDIT, para que `assertLedgerConsistent` passe.
 */
export async function createWalletDirect(
  balance: string,
  opts: { currency?: string; playerId?: string; pool?: Pool } = {},
): Promise<DirectWallet> {
  const pool = opts.pool ?? ownerPool();
  const walletId = uuid();
  const playerId = opts.playerId ?? uuid();
  const currency = opts.currency ?? "BRL";

  await pool.query(
    `INSERT INTO wallets (id, player_id, currency, balance, version) VALUES ($1, $2, $3, $4, 1)`,
    [walletId, playerId, currency, balance],
  );

  if (balance !== "0.00") {
    const txId = uuid();
    const external = `opening:${walletId}`;
    await pool.query(
      `INSERT INTO wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
          round_id, game_id, kind, amount, currency, status, result_balance, result_currency, processed_at)
       VALUES ($1, 'internal', $2, $2, $3, $4, $5, 'opening', 'opening', 'OPENING', $6, $7,
               'PROCESSED', $6, $7, now())`,
      [txId, external, "0".repeat(64), walletId, playerId, balance, currency],
    );
    await pool.query(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       VALUES ($1, $2, $3, 'CREDIT', $4, $5, '0.00', $4)`,
      [uuid(), walletId, txId, balance, currency],
    );
  }
  return { walletId, playerId, currency, balance };
}
