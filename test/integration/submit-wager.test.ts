import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { WagerCommand } from "../../src/application/wagering/wager-command";
import { WagerTransactionKind as Kind } from "../../src/domain/wagering/enums";
import { assertLedgerConsistent } from "../helpers/assert-ledger-consistent";
import { closePools, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { buildWagerCommand, createWalletDirect, type DirectWallet } from "../helpers/factories";
import { getJson, postWager } from "../helpers/wager-http";
import { startWageringTestApp } from "../helpers/wagering-app";

let baseUrl: string;
let close: () => Promise<void>;
let wallet: DirectWallet;

beforeAll(async () => {
  await migrateUp();
  const app = await startWageringTestApp();
  baseUrl = app.baseUrl;
  close = app.close;
});
beforeEach(async () => {
  await resetDb();
  wallet = await createWalletDirect("1000.00");
});
afterEach(async () => {
  await assertLedgerConsistent();
});
afterAll(async () => {
  await close();
  await closePools();
});

const cmd = (o: Partial<WagerCommand> = {}) =>
  buildWagerCommand({ walletId: wallet.walletId, playerId: wallet.playerId, ...o });

async function count(table: string, where = "true"): Promise<number> {
  const r = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`);
  return Number(r.rows[0]!.n);
}

describe("POST /wagering/transactions", () => {
  test("BET 25.00: 200 PROCESSED, balance 975.00, idempotentReplay false; outbox grows in the same commit", async () => {
    const outboxBefore = await count("outbox_messages");
    const res = await postWager(baseUrl, cmd());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "975.00", currency: "BRL" },
      failureCode: null,
      idempotentReplay: false,
    });
    expect(typeof res.body.transactionId).toBe("string");
    expect(await count("outbox_messages")).toBe(outboxBefore + 2);
  });

  test("the same request again: 200, idempotentReplay true, balance still 975.00 after another BET", async () => {
    const first = cmd();
    const a = await postWager(baseUrl, first);
    await postWager(baseUrl, cmd({ money: { amount: "100.00", currency: "BRL" } }));
    const outboxBefore = await count("outbox_messages");
    const b = await postWager(baseUrl, first);
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ status: "PROCESSED", balance: { amount: "975.00" }, idempotentReplay: true });
    expect(b.body.transactionId).toBe(a.body.transactionId);
    expect(await count("outbox_messages")).toBe(outboxBefore);
  });

  test("same key with amount 26.00: 409 IDEMPOTENCY_CONFLICT; balance and rows unchanged", async () => {
    const first = cmd();
    await postWager(baseUrl, first);
    const txBefore = await count("wager_transactions");
    const res = await postWager(baseUrl, { ...first, money: { amount: "26.00", currency: "BRL" } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await count("wager_transactions")).toBe(txBefore);
    const w = await ownerPool().query(`SELECT balance::text AS b FROM wallets WHERE id = $1`, [wallet.walletId]);
    expect(w.rows[0].b).toBe("975.00");
  });

  test("new key with the same externalTransactionId: 409 EXTERNAL_ID_CONFLICT", async () => {
    const first = cmd();
    await postWager(baseUrl, first);
    const res = await postWager(baseUrl, first, { key: "a-brand-new-key" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EXTERNAL_ID_CONFLICT");
  });

  test("BET 2000.00: 422 INSUFFICIENT_FUNDS without ledger; replay is 422 with idempotentReplay true", async () => {
    const big = cmd({ money: { amount: "2000.00", currency: "BRL" } });
    const ledgerBefore = await count("wallet_ledger_entries");
    const a = await postWager(baseUrl, big);
    expect(a.status).toBe(422);
    expect(a.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", idempotentReplay: false });
    expect(await count("wallet_ledger_entries")).toBe(ledgerBefore);

    const b = await postWager(baseUrl, big);
    expect(b.status).toBe(422);
    expect(b.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", idempotentReplay: true });
  });

  test("unknown wallet (valid UUID): 422 WALLET_NOT_FOUND, no wager_transactions row, 1 Rejected event", async () => {
    const res = await postWager(baseUrl, buildWagerCommand());
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ transactionId: null, status: "REJECTED", failureCode: "WALLET_NOT_FOUND" });
    expect(await count("wager_transactions", "kind <> 'OPENING'")).toBe(0);
    expect(await count("outbox_messages", "event_type = 'WagerTransactionRejected'")).toBe(1);
  });

  test("BET in USD: 422 CURRENCY_MISMATCH", async () => {
    const res = await postWager(baseUrl, cmd({ money: { amount: "1.00", currency: "USD" } }));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe("CURRENCY_MISMATCH");
  });

  test("LOSS: 200 PROCESSED, no ledger entry, version unchanged, Processed without BalanceChanged", async () => {
    const ledgerBefore = await count("wallet_ledger_entries");
    const res = await postWager(baseUrl, cmd({ kind: Kind.Loss }));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PROCESSED");
    expect(await count("wallet_ledger_entries")).toBe(ledgerBefore);
    const w = await ownerPool().query(`SELECT version FROM wallets WHERE id = $1`, [wallet.walletId]);
    expect(w.rows[0].version).toBe(1);
    expect(await count("outbox_messages", "event_type = 'WagerTransactionProcessed'")).toBe(1);
    expect(await count("outbox_messages", "event_type = 'WalletBalanceChanged'")).toBe(0);
  });

  test("every success writes its outbox rows in the same commit (counted before and after)", async () => {
    for (const kind of [Kind.Bet, Kind.Win, Kind.Loss] as const) {
      const before = await count("outbox_messages");
      const res = await postWager(baseUrl, cmd({ kind }));
      expect(res.status).toBe(200);
      expect((await count("outbox_messages")) - before).toBe(kind === Kind.Loss ? 1 : 2);
    }
  });
});

describe("POST /wagering/transactions: input validation", () => {
  test("missing Idempotency-Key: 400 INVALID_PAYLOAD", async () => {
    const res = await postWager(baseUrl, cmd(), { key: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PAYLOAD");
  });

  test("OPENING: 400 KIND_NOT_ALLOWED", async () => {
    const res = await postWager(baseUrl, cmd({ kind: Kind.Opening as never }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("KIND_NOT_ALLOWED");
  });

  test("amount without 2 decimals: 400 INVALID_MONEY", async () => {
    const res = await postWager(baseUrl, cmd({ money: { amount: "25", currency: "BRL" } }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_MONEY");
  });

  test("amount above NUMERIC(20,2) is 400 INVALID_MONEY, not 500", async () => {
    const res = await postWager(baseUrl, cmd({ money: { amount: "1000000000000000000.00", currency: "BRL" } }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_MONEY");
  });

  test("walletId that is not a UUID: 400 INVALID_PAYLOAD, not 500", async () => {
    const res = await postWager(baseUrl, cmd({ walletId: "not-a-uuid" }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PAYLOAD");
  });

  test("invalid payloads persist nothing", async () => {
    const before = await count("wager_transactions");
    const events = await count("outbox_messages");
    await postWager(baseUrl, cmd({ walletId: "x" }));
    await postWager(baseUrl, cmd({ money: { amount: "1e3", currency: "BRL" } }));
    expect(await count("wager_transactions")).toBe(before);
    expect(await count("outbox_messages")).toBe(events);
  });

  test("X-Correlation-Id is propagated to the outbox events", async () => {
    await postWager(baseUrl, cmd(), { headers: { "x-correlation-id": "corr-from-header" } });
    const r = await ownerPool().query(`SELECT DISTINCT payload->>'correlationId' AS c FROM outbox_messages`);
    expect(r.rows).toEqual([{ c: "corr-from-header" }]);
  });
});

describe("GET transaction", () => {
  test("by internal id and by provider + externalTransactionId", async () => {
    const c = cmd({ providerId: "provider-a", externalTransactionId: "transaction-123" });
    const posted = await postWager(baseUrl, c);

    const byId = await getJson(baseUrl, `/wagering/transactions/${posted.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      id: posted.body.transactionId,
      status: "PROCESSED",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      resultBalance: { amount: "975.00", currency: "BRL" },
    });

    const byExt = await getJson(baseUrl, "/providers/provider-a/wagering/transactions/transaction-123");
    expect(byExt.status).toBe(200);
    expect(byExt.body.id).toBe(posted.body.transactionId);
  });

  test("unknown ids are 404 and a non-UUID id is 400", async () => {
    expect((await getJson(baseUrl, `/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await getJson(baseUrl, "/providers/provider-a/wagering/transactions/nope")).status).toBe(404);
    expect((await getJson(baseUrl, "/wagering/transactions/not-a-uuid")).status).toBe(400);
  });
});
