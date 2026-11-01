/** O driver do MikroORM devolve timestamptz como string (`2026-10-31 12:00:00+00`); aceitamos os dois. */
export type DbDate = Date | string;

/**
 * Formato das linhas como o `pg` as entrega (snake_case). NUMERIC chega como string,
 * timestamptz como string (ver DbDate), bigint (seq, count) como string. Nada aqui é `number` para dinheiro.
 */
export interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: DbDate;
  updated_at: DbDate;
}

export interface WagerTransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  result_balance: string | null;
  result_currency: string | null;
  attempts: number;
  next_attempt_at: DbDate | null;
  created_at: DbDate;
  processed_at: DbDate | null;
}

export interface LedgerEntryRow {
  id: string;
  seq: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: DbDate;
}

export interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: DbDate;
  attempts: number;
  next_attempt_at: DbDate;
  locked_until: DbDate | null;
  published_at: DbDate | null;
}
