import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import { appPool, closePools, migrateDown, migrateDownLast, migrateUp, ownerPool, resetDb } from "../helpers/db";

/** Reverte as duas últimas migrations: a de retenção (mais nova) e a de consistência do ledger. */
async function migrateDownLedgerConsistency(): Promise<void> {
  await migrateDownLast();
  await migrateDownLast();
}

const uuid = () => crypto.randomUUID();

async function pgCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return (e as { code?: string }).code ?? "no-code";
  }
  return "no-error";
}

async function pgMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return (e as Error).message;
  }
  return "no-error";
}

interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
}

async function insertWallet(pool: Pool, o: Partial<WalletRow> = {}): Promise<WalletRow> {
  const w: WalletRow = {
    id: o.id ?? uuid(),
    playerId: o.playerId ?? uuid(),
    currency: o.currency ?? "BRL",
    balance: o.balance ?? "100.00",
  };
  await pool.query(
    `INSERT INTO wallets (id, player_id, currency, balance, version) VALUES ($1, $2, $3, $4, 1)`,
    [w.id, w.playerId, w.currency, w.balance],
  );
  return w;
}

interface TxOver {
  id?: string;
  providerId?: string;
  externalId?: string;
  idempotencyKey?: string;
  kind?: string;
  status?: string;
  amount?: string;
  referenceExternalId?: string | null;
  referenceTransactionId?: string | null;
  processedAt?: string | null;
  failureCode?: string | null;
}

async function insertTx(pool: Pool, wallet: WalletRow, o: TxOver = {}): Promise<string> {
  const id = o.id ?? uuid();
  const status = o.status ?? "PROCESSED";
  const processedAt = o.processedAt === undefined ? (status === "PROCESSED" ? "2026-10-31T00:00:00Z" : null) : o.processedAt;
  await pool.query(
    `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        round_id, game_id, kind, amount, currency, reference_external_transaction_id,
        reference_transaction_id, status, failure_code, result_balance, result_currency, processed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'round-1', 'game-1', $8, $9, $10, $11, $12, $13, $14, $15, $10, $16)`,
    [
      id,
      o.providerId ?? "provider-a",
      o.externalId ?? `ext-${id}`,
      o.idempotencyKey ?? `key-${id}`,
      "a".repeat(64),
      wallet.id,
      wallet.playerId,
      o.kind ?? "BET",
      o.amount ?? "25.00",
      wallet.currency,
      o.referenceExternalId ?? null,
      o.referenceTransactionId ?? null,
      status,
      o.failureCode ?? (status === "REJECTED" || status === "FAILED" ? "INSUFFICIENT_FUNDS" : null),
      "75.00",
      processedAt,
    ],
  );
  return id;
}

async function insertLedger(
  pool: Pool,
  wallet: WalletRow,
  transactionId: string,
  o: { direction?: string; amount?: string; before?: string; after?: string } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      uuid(),
      wallet.id,
      transactionId,
      o.direction ?? "DEBIT",
      o.amount ?? "25.00",
      wallet.currency,
      o.before ?? "100.00",
      o.after ?? "75.00",
    ],
  );
}

beforeAll(async () => {
  await migrateUp();
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closePools();
});

describe("migrations", () => {
  test("down followed by up runs clean and the 5 tables exist", async () => {
    await migrateDown();
    const gone = await ownerPool().query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
       AND table_name = ANY($1)`,
      [["wallets", "wager_transactions", "wallet_ledger_entries", "inbox_messages", "outbox_messages"]],
    );
    expect(gone.rowCount).toBe(0);

    await migrateUp();
    const present = await ownerPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
       AND table_name = ANY($1) ORDER BY table_name`,
      [["wallets", "wager_transactions", "wallet_ledger_entries", "inbox_messages", "outbox_messages"]],
    );
    expect(present.rows.map((r) => r.table_name)).toEqual([
      "inbox_messages",
      "outbox_messages",
      "wager_transactions",
      "wallet_ledger_entries",
      "wallets",
    ]);
  });

  test("named triggers and partial indexes exist", async () => {
    const triggers = await ownerPool().query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`,
    );
    expect(triggers.rows.map((r) => r.tgname)).toEqual(["ledger_immutable", "wager_tx_guard"]);

    const indexes = await ownerPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const defs = indexes.rows.map((r) => r.indexdef).join("\n");
    expect(defs).toMatch(/UNIQUE INDEX .*\(reference_transaction_id\) WHERE/);
    expect(defs).toMatch(/\(next_attempt_at\) WHERE .*PENDING_REFERENCE/);
    expect(defs).toMatch(/\(provider_id, reference_external_transaction_id\)/);
    expect(defs).toMatch(/\(next_attempt_at\) WHERE .*published_at IS NULL/);
  });
});

describe("wallets", () => {
  test("same (player_id, currency) twice is 23505", async () => {
    const w = await insertWallet(appPool());
    expect(await pgCode(insertWallet(appPool(), { playerId: w.playerId }))).toBe("23505");
  });

  test("same player in another currency is allowed", async () => {
    const w = await insertWallet(appPool());
    await insertWallet(appPool(), { playerId: w.playerId, currency: "USD" });
  });

  test("UPDATE balance = -1 is 23514", async () => {
    const w = await insertWallet(appPool());
    expect(await pgCode(appPool().query(`UPDATE wallets SET balance = -1 WHERE id = $1`, [w.id]))).toBe("23514");
  });

  test("version below 1 is 23514", async () => {
    const w = await insertWallet(appPool());
    expect(await pgCode(appPool().query(`UPDATE wallets SET version = 0 WHERE id = $1`, [w.id]))).toBe("23514");
  });

  test("lowercase currency is 23514", async () => {
    expect(await pgCode(insertWallet(appPool(), { currency: "brl" }))).toBe("23514");
  });

  test("app role cannot DELETE wallets", async () => {
    const w = await insertWallet(appPool());
    expect(await pgCode(appPool().query(`DELETE FROM wallets WHERE id = $1`, [w.id]))).toBe("42501");
  });
});

describe("wallet_ledger_entries", () => {
  test("DEBIT with balance_after different from balance_before - amount is 23514", async () => {
    const w = await insertWallet(appPool());
    const tx = await insertTx(appPool(), w);
    expect(await pgCode(insertLedger(appPool(), w, tx, { direction: "DEBIT", amount: "25.00", before: "100.00", after: "80.00" }))).toBe("23514");
  });

  test("CREDIT with balance_after different from balance_before + amount is 23514", async () => {
    const w = await insertWallet(appPool());
    const tx = await insertTx(appPool(), w);
    expect(await pgCode(insertLedger(appPool(), w, tx, { direction: "CREDIT", amount: "25.00", before: "100.00", after: "75.00" }))).toBe("23514");
  });

  test("a balanced CREDIT and DEBIT are accepted", async () => {
    const w = await insertWallet(appPool());
    const t1 = await insertTx(appPool(), w);
    const t2 = await insertTx(appPool(), w);
    await insertLedger(appPool(), w, t1, { direction: "DEBIT", amount: "25.00", before: "100.00", after: "75.00" });
    await insertLedger(appPool(), w, t2, { direction: "CREDIT", amount: "25.00", before: "75.00", after: "100.00" });
  });

  test("amount of zero is 23514", async () => {
    const w = await insertWallet(appPool());
    const tx = await insertTx(appPool(), w);
    expect(await pgCode(insertLedger(appPool(), w, tx, { amount: "0.00", before: "100.00", after: "100.00" }))).toBe("23514");
  });

  test("negative balance_after is 23514", async () => {
    const w = await insertWallet(appPool());
    const tx = await insertTx(appPool(), w);
    expect(await pgCode(insertLedger(appPool(), w, tx, { direction: "DEBIT", amount: "30.00", before: "20.00", after: "-10.00" }))).toBe("23514");
  });

  test("UPDATE as owner fails with 'immutable'; as app fails with 42501", async () => {
    const w = await insertWallet(appPool());
    const tx = await insertTx(appPool(), w);
    await insertLedger(appPool(), w, tx);
    expect(await pgMessage(ownerPool().query(`UPDATE wallet_ledger_entries SET created_at = now()`))).toContain("immutable");
    expect(await pgCode(appPool().query(`UPDATE wallet_ledger_entries SET created_at = now()`))).toBe("42501");
  });

  test("DELETE fails for owner (trigger) and for app (permission)", async () => {
    const w = await insertWallet(appPool());
    const tx = await insertTx(appPool(), w);
    await insertLedger(appPool(), w, tx);
    expect(await pgMessage(ownerPool().query(`DELETE FROM wallet_ledger_entries`))).toContain("immutable");
    expect(await pgCode(appPool().query(`DELETE FROM wallet_ledger_entries`))).toBe("42501");
    const left = await ownerPool().query(`SELECT count(*)::text AS n FROM wallet_ledger_entries`);
    expect(left.rows[0].n).toBe("1");
  });

  test("two entries for the same (wallet_id, transaction_id) is 23505", async () => {
    const w = await insertWallet(appPool());
    const tx = await insertTx(appPool(), w);
    await insertLedger(appPool(), w, tx);
    expect(await pgCode(insertLedger(appPool(), w, tx))).toBe("23505");
  });

  test("seq is increasing", async () => {
    const w = await insertWallet(appPool());
    const t1 = await insertTx(appPool(), w);
    const t2 = await insertTx(appPool(), w);
    await insertLedger(appPool(), w, t1);
    await insertLedger(appPool(), w, t2, { direction: "CREDIT", amount: "25.00", before: "75.00", after: "100.00" });
    const r = await ownerPool().query<{ seq: string }>(`SELECT seq::text FROM wallet_ledger_entries ORDER BY seq`);
    expect(r.rows.map((x) => x.seq)).toEqual(["1", "2"]);
  });
});

describe("wager_transactions", () => {
  test("same (provider_id, idempotency_key) is 23505", async () => {
    const w = await insertWallet(appPool());
    await insertTx(appPool(), w, { idempotencyKey: "k1" });
    expect(await pgCode(insertTx(appPool(), w, { idempotencyKey: "k1" }))).toBe("23505");
  });

  test("same (provider_id, external_transaction_id) is 23505", async () => {
    const w = await insertWallet(appPool());
    await insertTx(appPool(), w, { externalId: "e1" });
    expect(await pgCode(insertTx(appPool(), w, { externalId: "e1" }))).toBe("23505");
  });

  test("same keys under another provider are allowed", async () => {
    const w = await insertWallet(appPool());
    await insertTx(appPool(), w, { idempotencyKey: "k1", externalId: "e1" });
    await insertTx(appPool(), w, { providerId: "provider-b", idempotencyKey: "k1", externalId: "e1" });
  });

  test("two PROCESSED REFUNDs with the same reference_transaction_id is 23505", async () => {
    const w = await insertWallet(appPool());
    const bet = await insertTx(appPool(), w);
    await insertTx(appPool(), w, { kind: "REFUND", referenceExternalId: "x", referenceTransactionId: bet });
    expect(
      await pgCode(insertTx(appPool(), w, { kind: "REFUND", referenceExternalId: "x", referenceTransactionId: bet })),
    ).toBe("23505");
  });

  test("a REFUND and a ROLLBACK of the same reference is 23505 (total reversal at most once)", async () => {
    const w = await insertWallet(appPool());
    const bet = await insertTx(appPool(), w);
    await insertTx(appPool(), w, { kind: "REFUND", referenceExternalId: "x", referenceTransactionId: bet });
    expect(
      await pgCode(insertTx(appPool(), w, { kind: "ROLLBACK", referenceExternalId: "x", referenceTransactionId: bet })),
    ).toBe("23505");
  });

  test("a REJECTED reversal does not block a PROCESSED one", async () => {
    const w = await insertWallet(appPool());
    const bet = await insertTx(appPool(), w);
    await insertTx(appPool(), w, { kind: "REFUND", status: "REJECTED", referenceExternalId: "x", referenceTransactionId: bet });
    await insertTx(appPool(), w, { kind: "REFUND", referenceExternalId: "x", referenceTransactionId: bet });
  });

  test("REFUND without reference_external_transaction_id is 23514", async () => {
    const w = await insertWallet(appPool());
    expect(await pgCode(insertTx(appPool(), w, { kind: "REFUND" }))).toBe("23514");
  });

  test("ROLLBACK without reference_external_transaction_id is 23514", async () => {
    const w = await insertWallet(appPool());
    expect(await pgCode(insertTx(appPool(), w, { kind: "ROLLBACK" }))).toBe("23514");
  });

  test("amount of zero is 23514", async () => {
    const w = await insertWallet(appPool());
    expect(await pgCode(insertTx(appPool(), w, { amount: "0.00" }))).toBe("23514");
  });

  test("unknown kind and unknown status are 23514", async () => {
    const w = await insertWallet(appPool());
    expect(await pgCode(insertTx(appPool(), w, { kind: "GIFT" }))).toBe("23514");
    expect(await pgCode(insertTx(appPool(), w, { status: "DONE", processedAt: null }))).toBe("23514");
  });

  test("PROCESSED without processed_at is 23514", async () => {
    const w = await insertWallet(appPool());
    expect(await pgCode(insertTx(appPool(), w, { status: "PROCESSED", processedAt: null }))).toBe("23514");
  });

  test("transaction pointing to a missing wallet is 23503", async () => {
    const ghost: WalletRow = { id: uuid(), playerId: uuid(), currency: "BRL", balance: "0.00" };
    expect(await pgCode(insertTx(appPool(), ghost))).toBe("23503");
  });

  test("UPDATE status of a PROCESSED row is rejected by the trigger", async () => {
    const w = await insertWallet(appPool());
    const id = await insertTx(appPool(), w, { status: "PROCESSED" });
    const msg = await pgMessage(appPool().query(`UPDATE wager_transactions SET status = 'REJECTED' WHERE id = $1`, [id]));
    expect(msg).toContain("terminal");
    const row = await ownerPool().query(`SELECT status FROM wager_transactions WHERE id = $1`, [id]);
    expect(row.rows[0].status).toBe("PROCESSED");
  });

  test("any UPDATE of a REJECTED or FAILED row is rejected by the trigger", async () => {
    const w = await insertWallet(appPool());
    const rejected = await insertTx(appPool(), w, { status: "REJECTED" });
    const failed = await insertTx(appPool(), w, { status: "FAILED" });
    for (const id of [rejected, failed]) {
      expect(await pgMessage(appPool().query(`UPDATE wager_transactions SET attempts = 5 WHERE id = $1`, [id]))).toContain("terminal");
    }
  });

  test("PENDING_REFERENCE row: status, attempts and result_balance can change", async () => {
    const w = await insertWallet(appPool());
    const id = await insertTx(appPool(), w, { kind: "REFUND", status: "PENDING_REFERENCE", referenceExternalId: "x" });
    await appPool().query(
      `UPDATE wager_transactions
         SET attempts = attempts + 1, next_attempt_at = now(), result_balance = '10.00', result_currency = 'BRL'
       WHERE id = $1`,
      [id],
    );
    await appPool().query(
      `UPDATE wager_transactions SET status = 'PROCESSED', processed_at = now() WHERE id = $1`,
      [id],
    );
    const row = await ownerPool().query(`SELECT status, attempts, result_balance::text AS rb FROM wager_transactions WHERE id = $1`, [id]);
    expect(row.rows[0]).toEqual({ status: "PROCESSED", attempts: 1, rb: "10.00" });
  });

  test("PENDING_REFERENCE row: business columns cannot change", async () => {
    const w = await insertWallet(appPool());
    const id = await insertTx(appPool(), w, { kind: "REFUND", status: "PENDING_REFERENCE", referenceExternalId: "x" });
    const cols: Array<[string, string]> = [
      ["amount", "'1.00'"],
      ["kind", "'WIN'"],
      ["payload_hash", `'${"b".repeat(64)}'`],
      ["reference_external_transaction_id", "'y'"],
      ["idempotency_key", "'other'"],
      ["round_id", "'other'"],
    ];
    for (const [col, val] of cols) {
      const msg = await pgMessage(appPool().query(`UPDATE wager_transactions SET ${col} = ${val} WHERE id = $1`, [id]));
      expect(msg).toContain("immutable column");
    }
  });

  test("DELETE is always rejected by the trigger", async () => {
    const w = await insertWallet(appPool());
    const id = await insertTx(appPool(), w, { kind: "REFUND", status: "PENDING_REFERENCE", referenceExternalId: "x" });
    expect(await pgCode(appPool().query(`DELETE FROM wager_transactions WHERE id = $1`, [id]))).toBe("42501");
    expect(await pgMessage(ownerPool().query(`DELETE FROM wager_transactions WHERE id = $1`, [id]))).toContain("cannot be deleted");
  });
});

describe("inbox_messages and outbox_messages", () => {
  test("duplicate (consumer_name, message_id) is 23505", async () => {
    const insert = () =>
      appPool().query(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES ('wager-transactions-consumer', 'm1', $1)`,
        ["c".repeat(64)],
      );
    await insert();
    expect(await pgCode(insert())).toBe("23505");
  });

  test("same message_id for another consumer is allowed", async () => {
    await appPool().query(`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES ('c1', 'm1', $1)`, ["c".repeat(64)]);
    await appPool().query(`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES ('c2', 'm1', $1)`, ["c".repeat(64)]);
  });

  test("outbox accepts a row and app can UPDATE it", async () => {
    const id = uuid();
    await appPool().query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
       VALUES ($1, $2, 'WalletCreated', '{"a":1}'::jsonb, now(), now())`,
      [id, uuid()],
    );
    await appPool().query(`UPDATE outbox_messages SET published_at = now(), locked_until = NULL WHERE id = $1`, [id]);
    const r = await ownerPool().query(`SELECT attempts FROM outbox_messages WHERE id = $1`, [id]);
    expect(r.rows[0].attempts).toBe(0);
  });
});

const LEDGER_CONSISTENCY_CONSTRAINTS = [
  "wallets_id_currency_uq",
  "wager_tx_id_wallet_uq",
  "ledger_wallet_currency_fk",
  "ledger_tx_wallet_fk",
];

async function constraintNames(): Promise<string[]> {
  const r = await ownerPool().query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conname = ANY($1) ORDER BY conname`,
    [LEDGER_CONSISTENCY_CONSTRAINTS],
  );
  return r.rows.map((row) => row.conname);
}

async function pgError(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    return { code: err.code, constraint: err.constraint };
  }
  return {};
}

describe("ledger consistency constraints", () => {
  test("a ledger entry whose currency differs from its wallet is 23503 on ledger_wallet_currency_fk", async () => {
    const w = await insertWallet(appPool(), { currency: "BRL" });
    const tx = await insertTx(appPool(), w);
    const usd = { ...w, currency: "USD" };
    expect(await pgError(insertLedger(appPool(), usd, tx))).toEqual({ code: "23503", constraint: "ledger_wallet_currency_fk" });
  });

  test("a ledger entry for wallet B pointing at a transaction of wallet A is 23503 on ledger_tx_wallet_fk", async () => {
    const a = await insertWallet(appPool());
    const b = await insertWallet(appPool());
    const txOfA = await insertTx(appPool(), a);
    expect(await pgError(insertLedger(appPool(), b, txOfA))).toEqual({ code: "23503", constraint: "ledger_tx_wallet_fk" });
  });

  test("a consistent ledger entry is still accepted", async () => {
    const w = await insertWallet(appPool());
    const tx = await insertTx(appPool(), w);
    await insertLedger(appPool(), w, tx);
  });

  test("down, up and up again run clean (the second up is a no-op) and the 4 constraints exist", async () => {
    await migrateDown();
    expect(await constraintNames()).toEqual([]);
    await migrateUp();
    await migrateUp();
    expect(await constraintNames()).toEqual([...LEDGER_CONSISTENCY_CONSTRAINTS].sort());
  });

  test("down of this migration alone drops the 4 constraints and keeps the initial schema", async () => {
    await migrateDownLedgerConsistency();
    try {
      expect(await constraintNames()).toEqual([]);
      const tables = await ownerPool().query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'wallet_ledger_entries'`);
      expect(tables.rowCount).toBe(1);
    } finally {
      await migrateUp();
    }
    expect(await constraintNames()).toEqual([...LEDGER_CONSISTENCY_CONSTRAINTS].sort());
  });

  test("up over consistent existing data passes", async () => {
    await migrateDownLedgerConsistency();
    try {
      const w = await insertWallet(ownerPool());
      const tx = await insertTx(ownerPool(), w);
      await insertLedger(ownerPool(), w, tx);
      await migrateUp();
    } finally {
      await resetDb();
      await migrateUp();
    }
    expect(await constraintNames()).toEqual([...LEDGER_CONSISTENCY_CONSTRAINTS].sort());
  });

  test("up over inconsistent existing data fails with a clear message and changes nothing", async () => {
    await migrateDownLedgerConsistency();
    try {
      const w = await insertWallet(ownerPool(), { currency: "BRL" });
      const tx = await insertTx(ownerPool(), w);
      await insertLedger(ownerPool(), { ...w, currency: "USD" }, tx);

      let message = "no-error";
      try {
        await migrateUp();
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("ledger_consistency");
      expect(message).toMatch(/currency/);
      expect(await constraintNames()).toEqual([]);
    } finally {
      await resetDb();
      await migrateUp();
    }
    expect(await constraintNames()).toEqual([...LEDGER_CONSISTENCY_CONSTRAINTS].sort());
  });

  test("up over a ledger entry whose transaction belongs to another wallet fails with a clear message", async () => {
    await migrateDownLedgerConsistency();
    try {
      const a = await insertWallet(ownerPool());
      const b = await insertWallet(ownerPool());
      const txOfA = await insertTx(ownerPool(), a);
      await insertLedger(ownerPool(), b, txOfA);

      let message = "no-error";
      try {
        await migrateUp();
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("ledger_consistency");
      expect(message).toMatch(/transaction/);
    } finally {
      await resetDb();
      await migrateUp();
    }
  });
});
