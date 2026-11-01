import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { ReconcileAllWallets } from "../../src/application/wallet/reconcile-all-wallets";
import type { Logger } from "../../src/application/ports/logger";
import { PgAdvisoryLock } from "../../src/infrastructure/persistence/pg-advisory-lock";
import { ReconciliationWorker } from "../../src/interfaces/workers/reconciliation.worker";
import { loadConfig } from "../../src/config/config";
import { closePools, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { TEST_APP_DATABASE_URL, TEST_SQS_ENDPOINT } from "../helpers/env";
import { buildWagerCommand, createWalletDirect, type DirectWallet } from "../helpers/factories";
import { startTestApp, type TestApp } from "../helpers/http";
import { postWager } from "../helpers/wager-http";

const silent: Logger = { info() {}, warn() {}, error() {} };

let app: TestApp;
let container: INestApplication;

beforeAll(async () => {
  await migrateUp();
  app = await startTestApp();
  container = app.app as INestApplication;
});
beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  // Nenhum teste pode deixar o lock preso: uma conexão nova precisa conseguir pegá-lo.
  const probe = new PgAdvisoryLock(TEST_APP_DATABASE_URL);
  const res = await probe.runExclusive("reconciliation", async () => "free");
  expect(res).toEqual({ acquired: true, value: "free" });
});
afterAll(async () => {
  await app.close();
  await closePools();
});

async function metric(name: string): Promise<number> {
  const text = await (await fetch(`${app.baseUrl}/metrics`)).text();
  const line = text.split("\n").find((l) => l.startsWith(`${name} `));
  return line === undefined ? 0 : Number(line.split(" ")[1]);
}

function config(env: Record<string, string> = {}) {
  return loadConfig({ DATABASE_URL: TEST_APP_DATABASE_URL, SQS_ENDPOINT: TEST_SQS_ENDPOINT, ...env });
}

describe("ReconcileAllWallets", () => {
  test("3 consistent wallets and 1 corrupted via SQL: checked 4, inconsistent = [corrupted], mismatch metric +1", async () => {
    const wallets: DirectWallet[] = [];
    for (let i = 0; i < 4; i++) wallets.push(await createWalletDirect("100.00"));
    const corrupted = wallets[2]!;
    await ownerPool().query(`UPDATE wallets SET balance = balance + 1.00 WHERE id = $1`, [corrupted.walletId]);
    const mismatchBefore = await metric("reconciliation_mismatches_total");

    const result = await container.get(ReconcileAllWallets).run();

    expect(result).toEqual({ checked: 4, inconsistent: [corrupted.walletId] });
    expect(await metric("reconciliation_mismatches_total")).toBe(mismatchBefore + 1);
  });

  test("walks more than one page of ids (page size 100)", async () => {
    await ownerPool().query(
      `INSERT INTO wallets (id, player_id, currency, balance, version)
       SELECT gen_random_uuid(), gen_random_uuid(), 'BRL', 0, 1 FROM generate_series(1, 230)`,
    );

    const result = await container.get(ReconcileAllWallets).run();

    expect(result.checked).toBe(230);
    expect(result.inconsistent).toEqual([]);
  });

  test("records run metrics: runs +1, wallets checked +N, last run timestamp set", async () => {
    await createWalletDirect("10.00");
    await createWalletDirect("10.00");
    const runsBefore = await metric("reconciliation_runs_total");
    const checkedBefore = await metric("reconciliation_wallets_checked_total");

    await container.get(ReconcileAllWallets).run();

    expect(await metric("reconciliation_runs_total")).toBe(runsBefore + 1);
    expect(await metric("reconciliation_wallets_checked_total")).toBe(checkedBefore + 2);
    expect(await metric("reconciliation_last_run_timestamp_seconds")).toBeGreaterThan(Date.now() / 1000 - 60);
  });

  test("a concurrent HTTP bet on a wallet being reconciled answers 200", async () => {
    const wallets: DirectWallet[] = [];
    for (let i = 0; i < 30; i++) wallets.push(await createWalletDirect("1000.00"));
    const target = wallets[0]!;

    const running = container.get(ReconcileAllWallets).run();
    const bets = await Promise.all(
      Array.from({ length: 10 }, () =>
        postWager(app.baseUrl, buildWagerCommand({ walletId: target.walletId, playerId: target.playerId })),
      ),
    );
    const result = await running;

    expect(bets.map((b) => b.status)).toEqual(Array(10).fill(200));
    expect(result.checked).toBe(30);
    // O saldo mudou durante a reconciliação, mas cada wallet é conferida sob FOR SHARE: nada diverge.
    expect(result.inconsistent).toEqual([]);
  });
});

describe("ReconciliationWorker (advisory lock)", () => {
  /** Job controlável: só termina quando o teste libera. */
  function gatedJob() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => (started = r));
    return {
      release,
      hasStarted,
      job: {
        run: async () => {
          started();
          await gate;
          return { checked: 7, inconsistent: [] as string[] };
        },
      },
    };
  }

  const worker = (job: { run(): Promise<{ checked: number; inconsistent: string[] }> }) =>
    new ReconciliationWorker(config(), silent, new PgAdvisoryLock(TEST_APP_DATABASE_URL), job as unknown as ReconcileAllWallets);

  test("two workers at the same time: one runs, the other is skipped; afterwards the lock is free again", async () => {
    const first = gatedJob();
    const a = worker(first.job);
    const b = worker({ run: async () => ({ checked: 99, inconsistent: [] }) });

    const running = a.runOnce();
    await first.hasStarted;
    const second = await b.runOnce();
    expect(second).toEqual({ status: "skipped" });

    first.release();
    expect(await running).toEqual({ status: "completed", checked: 7, inconsistent: [] });

    expect(await b.runOnce()).toEqual({ status: "completed", checked: 99, inconsistent: [] });
  });

  test("the lock survives commits of other connections during the cycle (dedicated connection)", async () => {
    const gated = gatedJob();
    const a = worker(gated.job);
    const running = a.runOnce();
    await gated.hasStarted;

    // Muita atividade no pool da aplicação enquanto o ciclo segura o lock.
    for (let i = 0; i < 20; i++) await ownerPool().query("SELECT 1");
    await createWalletDirect("5.00");
    await postWager(app.baseUrl, buildWagerCommand({ walletId: crypto.randomUUID() }));

    expect(await worker({ run: async () => ({ checked: 0, inconsistent: [] }) }).runOnce()).toEqual({ status: "skipped" });
    gated.release();
    await running;
  });

  test("a job that throws releases the lock and the error is not swallowed by runOnce", async () => {
    const failing = worker({
      run: async () => {
        throw new Error("boom");
      },
    });
    await expect(failing.runOnce()).rejects.toThrow("boom");
    expect(await worker({ run: async () => ({ checked: 1, inconsistent: [] }) }).runOnce()).toEqual({
      status: "completed",
      checked: 1,
      inconsistent: [],
    });
  });
});

describe("papel reconciler", () => {
  test("the loop is off without the role", () => {
    expect(container.get(ReconciliationWorker).isRunning()).toBe(false);
  });

  test("with the role it runs on its own, and stops on shutdown", async () => {
    await createWalletDirect("10.00");
    const on = await startTestApp({ APP_ROLES: "api,reconciler", RECONCILE_INTERVAL_MS: "200" });
    const w = (on.app as INestApplication).get(ReconciliationWorker);
    try {
      expect(w.isRunning()).toBe(true);
      let runs = 0;
      for (let i = 0; i < 60 && runs === 0; i++) {
        await Bun.sleep(100);
        const text = await (await fetch(`${on.baseUrl}/metrics`)).text();
        const line = text.split("\n").find((l) => l.startsWith("reconciliation_runs_total "));
        runs = line === undefined ? 0 : Number(line.split(" ")[1]);
      }
      expect(runs).toBeGreaterThan(0);
    } finally {
      await on.close();
    }
    expect(w.isRunning()).toBe(false);
  });

  test("RECONCILE_INTERVAL_MS defaults to 300000", () => {
    expect(config().reconciliation.intervalMs).toBe(300_000);
    expect(config({ APP_ROLES: "reconciler" }).roles.has("reconciler")).toBe(true);
  });
});
