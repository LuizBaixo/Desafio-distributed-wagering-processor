import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { assertLedgerConsistent } from "../helpers/assert-ledger-consistent";
import { closePools, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { startTestApp } from "../helpers/http";

// O endpoint de aposta (Tarefa 11) ainda não está ligado ao app: as movimentações
// são gravadas direto no banco como owner, com a mesma forma que o caso de uso gravaria.

const PLAYER = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";

let baseUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  await migrateUp();
  const app = await startTestApp();
  baseUrl = app.baseUrl;
  close = app.close;
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await close();
  await closePools();
});

async function createWallet(amount: string): Promise<string> {
  const res = await fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId: PLAYER, initialBalance: { amount, currency: "BRL" } }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

interface Movement {
  kind: "BET" | "WIN" | "REFUND";
  direction: "DEBIT" | "CREDIT";
  amount: string;
  before: string;
  after: string;
  referenceTxId?: string;
  referenceExternalId?: string;
}

/** Grava uma movimentação (transação PROCESSED + lançamento + saldo) como owner. Devolve o id da transação. */
async function seed(walletId: string, m: Movement): Promise<{ txId: string; externalId: string }> {
  const pool = ownerPool();
  const txId = crypto.randomUUID();
  const externalId = `ext-${txId}`;
  await pool.query(
    `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
        status, result_balance, result_currency, processed_at)
     VALUES ($1, 'provider-a', $2, $2, $3, $4, $5, 'round-1', 'game-1', $6, $7, 'BRL', $8, $9,
             'PROCESSED', $10, 'BRL', now())`,
    [
      txId,
      externalId,
      "c".repeat(64),
      walletId,
      PLAYER,
      m.kind,
      m.amount,
      m.referenceExternalId ?? null,
      m.referenceTxId ?? null,
      m.after,
    ],
  );
  await pool.query(
    `INSERT INTO wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
     VALUES ($1, $2, $3, $4, $5, 'BRL', $6, $7)`,
    [crypto.randomUUID(), walletId, txId, m.direction, m.amount, m.before, m.after],
  );
  await pool.query(`UPDATE wallets SET balance = $2, version = version + 1 WHERE id = $1`, [walletId, m.after]);
  return { txId, externalId };
}

async function reconcile(walletId: string): Promise<Response> {
  return fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, { method: "POST" });
}

async function metricValue(name: string): Promise<number> {
  const text = await (await fetch(`${baseUrl}/metrics`)).text();
  const match = new RegExp(`^${name} (\\d+(?:\\.\\d+)?)$`, "m").exec(text);
  return match ? Number(match[1]) : 0;
}

describe("POST /wallets/:walletId/reconciliation", () => {
  afterEach(async () => {
    await assertLedgerConsistent();
  });

  test("após OPENING, BET, WIN e REFUND: consistent true, difference 0.00, checkedEntries = lançamentos", async () => {
    const walletId = await createWallet("1000.00");
    const bet = await seed(walletId, {
      kind: "BET",
      direction: "DEBIT",
      amount: "25.00",
      before: "1000.00",
      after: "975.00",
    });
    await seed(walletId, { kind: "WIN", direction: "CREDIT", amount: "50.00", before: "975.00", after: "1025.00" });
    await seed(walletId, {
      kind: "REFUND",
      direction: "CREDIT",
      amount: "25.00",
      before: "1025.00",
      after: "1050.00",
      referenceTxId: bet.txId,
      referenceExternalId: bet.externalId,
    });

    const res = await reconcile(walletId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      walletId,
      storedBalance: { amount: "1050.00", currency: "BRL" },
      calculatedBalance: { amount: "1050.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 4,
    });
  });

  test("ledger alterado (balance + 1 via SQL): consistent false, difference 1.00, saldo não corrigido, métrica sobe", async () => {
    // Este teste corrompe dados de propósito: não roda assertLedgerConsistent e termina com resetDb.
    try {
      const walletId = await createWallet("100.00");
      const before = await metricValue("reconciliation_mismatches_total");

      await ownerPool().query(`UPDATE wallets SET balance = balance + 1 WHERE id = $1`, [walletId]);

      const res = await reconcile(walletId);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        consistent: boolean;
        difference: { amount: string };
        storedBalance: { amount: string };
      };
      expect(body.consistent).toBe(false);
      expect(body.difference.amount).toBe("1.00");
      expect(body.storedBalance.amount).toBe("101.00");

      const after = await metricValue("reconciliation_mismatches_total");
      expect(after).toBe(before + 1);

      const stored = await ownerPool().query<{ balance: string }>(`SELECT balance FROM wallets WHERE id = $1`, [walletId]);
      expect(stored.rows[0]?.balance).toBe("101.00");
    } finally {
      await resetDb();
    }
  });

  test("wallet inexistente dá 404", async () => {
    const res = await reconcile("0192f291-27dd-7d3f-8071-5f8685deef37");
    expect(res.status).toBe(404);
  });

  test("walletId que não é UUID dá 400", async () => {
    const res = await reconcile("not-a-uuid");
    expect(res.status).toBe(400);
  });
});
