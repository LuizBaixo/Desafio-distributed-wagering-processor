import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work";
import { PromMetrics } from "../../src/infrastructure/observability/prom-metrics";
import { closePools, createAppOrm, migrateUp, resetDb } from "../helpers/db";
import { createWalletDirect } from "../helpers/factories";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let orm: MikroORM;
let metrics: PromMetrics;
let uow: MikroUnitOfWork;

beforeAll(async () => {
  await migrateUp();
  orm = await createAppOrm();
});

beforeEach(async () => {
  await resetDb();
  metrics = new PromMetrics();
  uow = new MikroUnitOfWork(orm.em, undefined, metrics);
});

afterAll(async () => {
  await orm.close(true);
  await closePools();
});

/** Valor de uma amostra do histograma sem labels, por exemplo `wallet_lock_wait_seconds_sum`. */
async function sample(name: string): Promise<number> {
  const text = await metrics.registry.metrics();
  const line = text.split("\n").find((l) => l.startsWith(`${name} `));
  return Number(line?.split(" ")[1] ?? "0");
}

describe("wallet_lock_wait_seconds", () => {
  test("a lockForUpdate that waits for another transaction is observed with its wait time", async () => {
    const w = await createWalletDirect("100.00");

    const holder = uow.run(async (s) => {
      await s.wallets.lockForUpdate(w.walletId);
      await sleep(300);
    });
    await sleep(50);
    await uow.run((s) => s.wallets.lockForUpdate(w.walletId));
    await holder;

    expect(await sample("wallet_lock_wait_seconds_sum")).toBeGreaterThanOrEqual(0.2);
    expect(await sample("wallet_lock_wait_seconds_count")).toBeGreaterThanOrEqual(1);
  });

  test("a lockForUpdate on a missing wallet is observed too", async () => {
    await uow.run((s) => s.wallets.lockForUpdate(crypto.randomUUID()));
    expect(await sample("wallet_lock_wait_seconds_count")).toBe(1);
  });

  test("lockForShare and findById are not observed", async () => {
    const w = await createWalletDirect("100.00");
    await uow.run(async (s) => {
      await s.wallets.lockForShare(w.walletId);
      await s.wallets.findById(w.walletId);
    });
    expect(await sample("wallet_lock_wait_seconds_count")).toBe(0);
  });
});
