import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnApp, type AppProcess } from "../helpers/app-process";
import { assertLedgerConsistent } from "../helpers/assert-ledger-consistent";
import { closePools, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { buildWagerCommand, createWalletDirect } from "../helpers/factories";
import { postWager } from "../helpers/wager-http";

/** Portas das 3 instâncias; TEST_PORT_BASE permite dois agentes rodarem ao mesmo tempo. */
const BASE_PORT = Number(process.env.TEST_PORT_BASE ?? 4101);

let apps: AppProcess[] = [];

beforeAll(async () => {
  await migrateUp();
  apps = await Promise.all([0, 1, 2].map((i) => spawnApp({ port: BASE_PORT + i, roles: "api" })));
}, 60_000);
beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await assertLedgerConsistent();
});
afterAll(async () => {
  await Promise.all(apps.map((a) => a.kill("SIGTERM")));
  await closePools();
});

const brl = (amount: string) => ({ amount, currency: "BRL" });
const roundRobin = (i: number) => apps[i % apps.length]!.baseUrl;

async function scalar(sql: string, params: unknown[] = []): Promise<string> {
  const r = await ownerPool().query<{ v: string }>(sql, params);
  return r.rows[0]!.v;
}

describe("C4: 3 API instances, requests round-robin", () => {
  test("the three instances are distinct processes", () => {
    expect(new Set(apps.map((a) => a.pid)).size).toBe(3);
  });

  test("C1 across instances: 50 identical BET 10.00 -> all 200, one non-replay, balance 990.00, one DEBIT, one row", async () => {
    const w = await createWalletDirect("1000.00");
    const cmd = buildWagerCommand({ walletId: w.walletId, playerId: w.playerId, money: brl("10.00") });

    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => postWager(roundRobin(i), cmd)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(await scalar(`SELECT balance::text AS v FROM wallets WHERE id = $1`, [w.walletId])).toBe("990.00");
    expect(await scalar(`SELECT count(*)::text AS v FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [w.walletId])).toBe("1");
    expect(await scalar(`SELECT count(*)::text AS v FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'`, [w.walletId])).toBe("1");
  });

  test("C2 across instances: two different BET 80.00 on 100.00 -> one 200, one 422; retries on the other instances change nothing", async () => {
    const w = await createWalletDirect("100.00");
    const a = buildWagerCommand({ walletId: w.walletId, playerId: w.playerId, money: brl("80.00") });
    const b = buildWagerCommand({ walletId: w.walletId, playerId: w.playerId, money: brl("80.00") });

    const [ra, rb] = await Promise.all([postWager(apps[0]!.baseUrl, a), postWager(apps[1]!.baseUrl, b)]);
    expect([ra.status, rb.status].sort()).toEqual([200, 422]);
    expect((ra.status === 422 ? ra : rb).body.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(await scalar(`SELECT balance::text AS v FROM wallets WHERE id = $1`, [w.walletId])).toBe("20.00");

    // Cada request é repetida em uma instância diferente da que a processou.
    const [ta, tb] = await Promise.all([postWager(apps[2]!.baseUrl, a), postWager(apps[0]!.baseUrl, b)]);
    expect(ta.status).toBe(ra.status);
    expect(tb.status).toBe(rb.status);
    expect(ta.body.idempotentReplay && tb.body.idempotentReplay).toBe(true);
    expect(await scalar(`SELECT balance::text AS v FROM wallets WHERE id = $1`, [w.walletId])).toBe("20.00");
    expect(await scalar(`SELECT count(*)::text AS v FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [w.walletId])).toBe("1");
  });

  test("C2b across instances: 40 distinct BET 10.00 on 100.00 -> exactly 10 PROCESSED, balance 0.00", async () => {
    const w = await createWalletDirect("100.00");
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        postWager(roundRobin(i), buildWagerCommand({ walletId: w.walletId, playerId: w.playerId, money: brl("10.00") })),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(10);
    expect(results.filter((r) => r.status === 422)).toHaveLength(30);
    expect(await scalar(`SELECT balance::text AS v FROM wallets WHERE id = $1`, [w.walletId])).toBe("0.00");
  });
});
