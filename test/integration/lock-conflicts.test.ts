import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { TransientInfrastructureError } from "../../src/application/errors";
import { closePools, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { buildWagerCommand, createWalletDirect } from "../helpers/factories";
import { buildWagerHarness, type WagerHarness } from "../helpers/wager-harness";

let h: WagerHarness;

beforeAll(async () => {
  await migrateUp();
  h = await buildWagerHarness(undefined, { lockTimeout: "300ms" });
});
beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await h.close();
  await closePools();
});

async function lockConflicts(): Promise<number> {
  const text = await h.metrics.registry.metrics();
  const line = text.split("\n").find((l) => l.startsWith("lock_conflicts_total "));
  return Number(line?.split(" ")[1] ?? "0");
}

describe("lock_conflicts_total", () => {
  test("real lock_timeout (55P03) on the wallet row counts exactly once and maps to 503-class error", async () => {
    const w = await createWalletDirect("1000.00");
    const holder = await ownerPool().connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM wallets WHERE id = $1 FOR UPDATE", [w.walletId]);

      const before = await lockConflicts();
      const err = await h.submit
        .execute(buildWagerCommand({ walletId: w.walletId, playerId: w.playerId }), { correlationId: "c1" })
        .then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(TransientInfrastructureError);
      expect(await lockConflicts()).toBe(before + 1);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  test("does not count a successful wager", async () => {
    const w = await createWalletDirect("1000.00");
    const before = await lockConflicts();
    await h.submit.execute(buildWagerCommand({ walletId: w.walletId, playerId: w.playerId }), { correlationId: "c2" });
    expect(await lockConflicts()).toBe(before);
  });
});
