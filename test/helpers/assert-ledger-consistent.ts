import type { Pool } from "pg";
import { ownerPool } from "./db";

/**
 * Para toda wallet: `balance = SUM(CREDIT) - SUM(DEBIT)` (a OPENING conta como CREDIT) e
 * `balance` igual ao `balance_after` do último `seq` (ou zero, sem lançamentos).
 * A soma e a comparação são feitas em SQL (NUMERIC); o valor só vira texto para o relatório.
 */
export async function assertLedgerConsistent(pool: Pool = ownerPool()): Promise<void> {
  const result = await pool.query<{
    id: string;
    balance: string;
    net: string;
    last_after: string | null;
  }>(`
    WITH net AS (
      SELECT wallet_id,
             COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0::numeric(20,2)) AS net
        FROM wallet_ledger_entries
       GROUP BY wallet_id
    ), last_entry AS (
      SELECT DISTINCT ON (wallet_id) wallet_id, balance_after
        FROM wallet_ledger_entries
       ORDER BY wallet_id, seq DESC
    )
    SELECT w.id,
           w.balance::text AS balance,
           COALESCE(n.net, 0::numeric(20,2))::text AS net,
           l.balance_after::text AS last_after
      FROM wallets w
      LEFT JOIN net n ON n.wallet_id = w.id
      LEFT JOIN last_entry l ON l.wallet_id = w.id
     WHERE w.balance <> COALESCE(n.net, 0::numeric(20,2))
        OR w.balance <> COALESCE(l.balance_after, 0::numeric(20,2))
     ORDER BY w.id
  `);

  if (result.rows.length > 0) {
    const lines = result.rows.map(
      (r) => `  wallet ${r.id}: balance=${r.balance} ledger_net=${r.net} last_balance_after=${r.last_after ?? "none"}`,
    );
    throw new Error(`ledger inconsistent for ${result.rows.length} wallet(s):\n${lines.join("\n")}`);
  }
}
