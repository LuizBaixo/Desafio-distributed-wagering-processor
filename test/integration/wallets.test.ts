import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { assertLedgerConsistent } from "../helpers/assert-ledger-consistent";
import { closePools, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { startTestApp } from "../helpers/http";

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

afterEach(async () => {
  await assertLedgerConsistent();
});

afterAll(async () => {
  await close();
  await closePools();
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createWallet(amount: string, currency = "BRL", playerId = PLAYER): Promise<{ id: string; version: number }> {
  const res = await post("/wallets", { playerId, initialBalance: { amount, currency } });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; version: number };
  return body;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params);
  return rows[0]!.n;
}

describe("POST /wallets", () => {
  test("1000.00 BRL responde 201 com version 1, saldo exato, 1 CREDIT e 3 eventos na outbox", async () => {
    const res = await post("/wallets", { playerId: PLAYER, initialBalance: { amount: "1000.00", currency: "BRL" } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; playerId: string; balance: unknown; version: number };
    expect(body.version).toBe(1);
    expect(body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(body.playerId).toBe(PLAYER);

    expect(await count("wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'CREDIT'", [body.id])).toBe(1);
    expect(await count("outbox_messages WHERE aggregate_id = $1", [body.id])).toBe(3);
  });

  test("saldo 0.00 não gera OPENING nem lançamento; ledger vazio", async () => {
    const { id } = await createWallet("0.00");
    expect(await count("wager_transactions WHERE wallet_id = $1", [id])).toBe(0);
    expect(await count("wallet_ledger_entries WHERE wallet_id = $1", [id])).toBe(0);
  });

  test("mesmo playerId e BRL duas vezes dá 409 WALLET_ALREADY_EXISTS; com USD dá 201", async () => {
    await createWallet("10.00");
    const dup = await post("/wallets", { playerId: PLAYER, initialBalance: { amount: "10.00", currency: "BRL" } });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("WALLET_ALREADY_EXISTS");

    const usd = await post("/wallets", { playerId: PLAYER, initialBalance: { amount: "10.00", currency: "USD" } });
    expect(usd.status).toBe(201);
  });

  test("initialBalance '10.5' dá 400 INVALID_MONEY", async () => {
    const res = await post("/wallets", { playerId: PLAYER, initialBalance: { amount: "10.5", currency: "BRL" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_MONEY");
  });

  test("playerId que não é UUID dá 400 (Foco de revisão 2)", async () => {
    const res = await post("/wallets", { playerId: "not-a-uuid", initialBalance: { amount: "10.00", currency: "BRL" } });
    expect(res.status).toBe(400);
  });
});

describe("GET /wallets/:walletId", () => {
  test("retorna a wallet criada", async () => {
    const { id } = await createWallet("250.00");
    const res = await fetch(`${baseUrl}/wallets/${id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, balance: { amount: "250.00", currency: "BRL" }, version: 1 });
  });

  test("GET /wallets/not-a-uuid dá 400 (Foco de revisão 2)", async () => {
    const res = await fetch(`${baseUrl}/wallets/not-a-uuid`);
    expect(res.status).toBe(400);
  });

  test("wallet inexistente dá 404", async () => {
    const res = await fetch(`${baseUrl}/wallets/0192f291-27dd-7d3f-8071-5f8685deef37`);
    expect(res.status).toBe(404);
  });
});

/** Adiciona N lançamentos CREDIT de 1.00 à wallet, cada um ligado a uma WIN PROCESSED própria. */
async function addCredits(walletId: string, playerId: string, n: number): Promise<void> {
  const pool = ownerPool();
  for (let i = 0; i < n; i++) {
    const txId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
          round_id, game_id, kind, amount, currency, status, result_balance, result_currency, processed_at)
       VALUES ($1, 'provider-a', $2, $2, $3, $4, $5, 'r', 'g', 'WIN', '1.00', 'BRL', 'PROCESSED',
               '1.00', 'BRL', now())`,
      [txId, `ext-${txId}`, "b".repeat(64), walletId, playerId],
    );
    await pool.query(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       VALUES ($1, $2, $3, 'CREDIT', '1.00', 'BRL', $4, $5)`,
      [crypto.randomUUID(), walletId, txId, `${i}.00`, `${i + 1}.00`],
    );
  }
  await pool.query(`UPDATE wallets SET balance = $2, version = version + $3 WHERE id = $1`, [
    walletId,
    `${n}.00`,
    n,
  ]);
}

describe("GET /wallets/:walletId/ledger", () => {
  test("120 lançamentos lidos com limit=50 em 3 páginas: 120 únicos, em ordem de seq, último nextCursor null", async () => {
    const { id } = await createWallet("0.00");
    await addCredits(id, PLAYER, 120);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs = cursor ? `?limit=50&cursor=${encodeURIComponent(cursor)}` : "?limit=50";
      const res = await fetch(`${baseUrl}/wallets/${id}/ledger${qs}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ seq: string }>; nextCursor: string | null };
      seen.push(...body.items.map((i) => i.seq));
      cursor = body.nextCursor;
      pages++;
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    const numeric = seen.map((s) => BigInt(s));
    for (let i = 1; i < numeric.length; i++) {
      expect(numeric[i]! > numeric[i - 1]!).toBe(true);
    }
  });

  test("cursor=abc!! dá 400 INVALID_PAYLOAD (Foco de revisão 3)", async () => {
    const { id } = await createWallet("10.00");
    const res = await fetch(`${baseUrl}/wallets/${id}/ledger?cursor=abc!!`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_PAYLOAD");
  });

  test("ledger de wallet inexistente dá 404", async () => {
    const res = await fetch(`${baseUrl}/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/ledger`);
    expect(res.status).toBe(404);
  });
});
