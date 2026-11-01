import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { assertLedgerConsistent } from "../helpers/assert-ledger-consistent";
import { closePools, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { buildWagerCommand, createWalletDirect } from "../helpers/factories";
import { startTestApp } from "../helpers/http";
import { postWager } from "../helpers/wager-http";

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

const brl = (amount: string) => ({ amount, currency: "BRL" });

async function scalar(sql: string, params: unknown[] = []): Promise<string> {
  const r = await ownerPool().query<{ v: string }>(sql, params);
  return r.rows[0]!.v;
}
const balanceOf = (walletId: string) => scalar(`SELECT balance::text AS v FROM wallets WHERE id = $1`, [walletId]);
const debitsOf = (walletId: string) =>
  scalar(`SELECT count(*)::text AS v FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [walletId]);
const betsOf = (walletId: string) =>
  scalar(`SELECT count(*)::text AS v FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'`, [walletId]);

describe("C1: identical requests", () => {
  test("50 identical BET 10.00 in parallel: all 200, exactly one non-replay, balance 990.00, one DEBIT, one row", async () => {
    const w = await createWalletDirect("1000.00");
    const cmd = buildWagerCommand({ walletId: w.walletId, playerId: w.playerId, money: brl("10.00") });

    const results = await Promise.all(Array.from({ length: 50 }, () => postWager(baseUrl, cmd)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.every((r) => r.body.balance.amount === "990.00")).toBe(true);
    expect(await balanceOf(w.walletId)).toBe("990.00");
    expect(await debitsOf(w.walletId)).toBe("1");
    expect(await betsOf(w.walletId)).toBe("1");
  });
});

describe("C2: hot wallet, insufficient funds", () => {
  test("two different BET 80.00 on 100.00: one 200 PROCESSED, one 422 INSUFFICIENT_FUNDS; retries change nothing", async () => {
    const w = await createWalletDirect("100.00");
    const a = buildWagerCommand({ walletId: w.walletId, playerId: w.playerId, money: brl("80.00") });
    const b = buildWagerCommand({ walletId: w.walletId, playerId: w.playerId, money: brl("80.00") });

    const [ra, rb] = await Promise.all([postWager(baseUrl, a), postWager(baseUrl, b)]);
    expect([ra.status, rb.status].sort()).toEqual([200, 422]);
    const rejected = ra.status === 422 ? ra : rb;
    expect(rejected.body.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(await balanceOf(w.walletId)).toBe("20.00");
    expect(await debitsOf(w.walletId)).toBe("1");

    // Retry de cada request: mesmo status, replay, nada muda.
    const [ta, tb] = await Promise.all([postWager(baseUrl, a), postWager(baseUrl, b)]);
    expect(ta.status).toBe(ra.status);
    expect(tb.status).toBe(rb.status);
    expect(ta.body.idempotentReplay && tb.body.idempotentReplay).toBe(true);
    expect(ta.body.transactionId).toBe(ra.body.transactionId);
    expect(tb.body.transactionId).toBe(rb.body.transactionId);
    expect(await balanceOf(w.walletId)).toBe("20.00");
    expect(await debitsOf(w.walletId)).toBe("1");
    expect(await betsOf(w.walletId)).toBe("2");
  });

  test("C2b: 40 distinct BET 10.00 in two parallel bursts on 100.00: exactly 10 PROCESSED, balance 0.00, never negative", async () => {
    const w = await createWalletDirect("100.00");
    const burst = () =>
      Array.from({ length: 20 }, () =>
        postWager(baseUrl, buildWagerCommand({ walletId: w.walletId, playerId: w.playerId, money: brl("10.00") })),
      );

    const results = await Promise.all([...burst(), ...burst()]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(10);
    const rejected = results.filter((r) => r.status === 422);
    expect(rejected).toHaveLength(30);
    expect(rejected.every((r) => r.body.failureCode === "INSUFFICIENT_FUNDS")).toBe(true);
    expect(await balanceOf(w.walletId)).toBe("0.00");
    expect(await debitsOf(w.walletId)).toBe("10");
    expect(await betsOf(w.walletId)).toBe("40");
    const negative = await scalar(`SELECT count(*)::text AS v FROM wallets WHERE balance < 0`);
    expect(negative).toBe("0");
  });
});

describe("C3: parallel wallets", () => {
  test("10 wallets x 20 BET 1.00 in parallel: each ends at initial - 20.00, faster than 1 wallet x 200 serial (no global lock)", async () => {
    // Serial: 1 wallet, 200 apostas, uma de cada vez.
    const solo = await createWalletDirect("1000.00");
    const serialStart = performance.now();
    for (let i = 0; i < 200; i++) {
      const res = await postWager(baseUrl, buildWagerCommand({ walletId: solo.walletId, playerId: solo.playerId, money: brl("1.00") }));
      expect(res.status).toBe(200);
    }
    const serialMs = performance.now() - serialStart;
    expect(await balanceOf(solo.walletId)).toBe("800.00");

    // Paralelo: 10 wallets x 20 apostas, tudo ao mesmo tempo.
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWalletDirect("100.00")));
    const parallelStart = performance.now();
    const results = await Promise.all(
      wallets.flatMap((w) =>
        Array.from({ length: 20 }, () =>
          postWager(baseUrl, buildWagerCommand({ walletId: w.walletId, playerId: w.playerId, money: brl("1.00") })),
        ),
      ),
    );
    const parallelMs = performance.now() - parallelStart;

    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const w of wallets) {
      expect(await balanceOf(w.walletId)).toBe("80.00");
      expect(await debitsOf(w.walletId)).toBe("20");
    }
    console.log(`C3 timing: serial 200 apostas = ${serialMs.toFixed(0)}ms, paralelo 10x20 = ${parallelMs.toFixed(0)}ms`);
    expect(parallelMs).toBeLessThan(serialMs);
  });
});
