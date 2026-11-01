import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnApp, type AppProcess } from "../helpers/app-process";
import { assertLedgerConsistent } from "../helpers/assert-ledger-consistent";
import { closePools, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { buildWagerCommand, createWalletDirect } from "../helpers/factories";
import { WAGER_DLQ, WAGER_QUEUE, purgeAll, queueDepth, receiveAll, sendWager, waitFor } from "../helpers/sqs";

/** Portas desta suíte ficam acima das de multi-instance (BASE..BASE+2). */
const BASE_PORT = Number(process.env.TEST_PORT_BASE ?? 4101) + 20;

let spawned: AppProcess[] = [];
async function start(port: number, roles: string, env: Record<string, string> = {}): Promise<AppProcess> {
  const app = await spawnApp({ port, roles, env: { NODE_ENV: "test", CONSUMER_WAIT_SECONDS: "1", ...env } });
  spawned.push(app);
  return app;
}

beforeAll(async () => {
  await migrateUp();
});
beforeEach(async () => {
  await resetDb();
  await purgeAll();
});
afterEach(async () => {
  await Promise.all(spawned.map((a) => a.kill("SIGKILL").catch(() => undefined)));
  spawned = [];
  await assertLedgerConsistent();
});
afterAll(async () => {
  await closePools();
});

async function scalar(sql: string, params: unknown[] = []): Promise<string> {
  const r = await ownerPool().query<{ v: string }>(sql, params);
  return r.rows[0]!.v;
}

describe("C5: crash between commit and ack", () => {
  test("process dies after the commit (137); a new process redelivers, the inbox deduplicates, one debit, queue empty", async () => {
    const w = await createWalletDirect("1000.00");
    const crashing = await start(BASE_PORT, "consumer", {
      FAULT_INJECT: "exit_after_commit",
      CONSUMER_VISIBILITY_TIMEOUT_SECONDS: "3",
    });
    const cmd = buildWagerCommand({
      walletId: w.walletId,
      playerId: w.playerId,
      money: { amount: "10.00", currency: "BRL" },
    });
    await sendWager(cmd);

    expect(await crashing.waitExit()).toBe(137);
    expect(await scalar(`SELECT status AS v FROM wager_transactions WHERE external_transaction_id = $1`, [cmd.externalTransactionId])).toBe("PROCESSED");
    expect(await scalar(`SELECT count(*)::text AS v FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [w.walletId])).toBe("1");
    expect(await queueDepth(WAGER_QUEUE)).toBe(1); // sem ack

    // Processo novo, sem falha injetada. A mensagem volta quando o visibility timeout vence.
    const fresh = await start(BASE_PORT + 1, "consumer", { CONSUMER_VISIBILITY_TIMEOUT_SECONDS: "3" });
    await waitFor(async () => (await queueDepth(WAGER_QUEUE)) === 0, { timeoutMs: 20_000, what: "redelivered message acknowledged" });

    expect(await scalar(`SELECT count(*)::text AS v FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [w.walletId])).toBe("1");
    expect(await scalar(`SELECT count(*)::text AS v FROM inbox_messages`)).toBe("1");
    expect(await scalar(`SELECT balance::text AS v FROM wallets WHERE id = $1`, [w.walletId])).toBe("990.00");
    expect(await receiveAll(WAGER_DLQ)).toHaveLength(0);

    const metrics = await (await fetch(`${fresh.baseUrl}/metrics`)).text();
    const inboxDuplicates = Number(/duplicates_detected_total\{source="inbox",result="message"\} (\d+)/.exec(metrics)?.[1] ?? 0);
    expect(inboxDuplicates).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
