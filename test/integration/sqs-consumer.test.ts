import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnApp } from "../helpers/app-process";
import { assertLedgerConsistent } from "../helpers/assert-ledger-consistent";
import { closePools, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { buildWagerCommand, createWalletDirect, type DirectWallet } from "../helpers/factories";
import { startTestApp, type TestApp } from "../helpers/http";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import {
  WAGER_DLQ,
  WAGER_QUEUE,
  purgeAll,
  queueDepth,
  queueUrl,
  receiveAll,
  sendRaw,
  sendWager,
  sqsClient,
  waitFor,
} from "../helpers/sqs";

/** Env comum dos consumers de teste: espera curta e backoff de 1 s para os retries não demorarem. */
const FAST = { APP_ROLES: "consumer", CONSUMER_WAIT_SECONDS: "1", CONSUMER_MAX_BACKOFF_SECONDS: "1" };

let apps: TestApp[] = [];
async function startConsumer(env: Record<string, string> = {}): Promise<TestApp> {
  const app = await startTestApp({ ...FAST, ...env });
  apps.push(app);
  return app;
}

let wallet: DirectWallet;

beforeAll(async () => {
  await migrateUp();
});
beforeEach(async () => {
  await resetDb();
  await purgeAll();
  wallet = await createWalletDirect("1000.00");
});
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close().catch(() => undefined)));
  apps = [];
  delete process.env.TEST_SLOW_MS;
  await assertLedgerConsistent();
});
afterAll(async () => {
  await closePools();
});

const bet = (amount = "25.00", o: Partial<ReturnType<typeof buildWagerCommand>> = {}) =>
  buildWagerCommand({ walletId: wallet.walletId, playerId: wallet.playerId, money: { amount, currency: "BRL" }, ...o });

async function scalar(sql: string, params: unknown[] = []): Promise<string> {
  const r = await ownerPool().query<{ v: string }>(sql, params);
  return r.rows[0]!.v;
}
const txStatus = (external: string) =>
  scalar(`SELECT status AS v FROM wager_transactions WHERE external_transaction_id = $1`, [external]);
const inboxRows = () => scalar(`SELECT count(*)::text AS v FROM inbox_messages`);
const debits = () => scalar(`SELECT count(*)::text AS v FROM wallet_ledger_entries WHERE direction = 'DEBIT'`);

async function waitProcessed(external: string): Promise<void> {
  await waitFor(async () => {
    const r = await ownerPool().query(`SELECT 1 FROM wager_transactions WHERE external_transaction_id = $1`, [external]);
    return (r.rowCount ?? 0) > 0;
  }, { what: `transaction ${external}` });
}

async function waitQueueEmpty(): Promise<void> {
  await waitFor(async () => (await queueDepth(WAGER_QUEUE)) === 0, { what: "main queue empty" });
}

describe("SQS consumer: happy path and deduplication", () => {
  test("a valid BET becomes PROCESSED, the inbox has 1 row and the main queue is empty", async () => {
    await startConsumer();
    const cmd = bet();
    await sendWager(cmd);
    await waitProcessed(cmd.externalTransactionId);
    await waitQueueEmpty();

    expect(await txStatus(cmd.externalTransactionId)).toBe("PROCESSED");
    expect(await inboxRows()).toBe("1");
    expect(await scalar(`SELECT balance::text AS v FROM wallets WHERE id = $1`, [wallet.walletId])).toBe("975.00");
    expect(await receiveAll(WAGER_DLQ)).toHaveLength(0);
  });

  test("the same messageId resent with another dedup id: the inbox catches it, a single debit", async () => {
    await startConsumer();
    const cmd = bet();
    const messageId = `msg-${crypto.randomUUID()}`;
    await sendWager(cmd, messageId, `dedup-1-${messageId}`);
    await waitProcessed(cmd.externalTransactionId);
    await waitQueueEmpty();

    await sendWager(cmd, messageId, `dedup-2-${messageId}`);
    await waitFor(async () => (await queueDepth(WAGER_QUEUE)) === 0, { what: "second delivery consumed" });
    await Bun.sleep(500);

    expect(await inboxRows()).toBe("1");
    expect(await debits()).toBe("1");
    expect(await scalar(`SELECT count(*)::text AS v FROM wager_transactions WHERE kind = 'BET'`)).toBe("1");
  });

  test("a different messageId with the same idempotencyKey is a replay: a single debit, two inbox rows", async () => {
    await startConsumer();
    const cmd = bet();
    await sendWager(cmd, `msg-a-${crypto.randomUUID()}`);
    await waitProcessed(cmd.externalTransactionId);
    await waitQueueEmpty();

    await sendWager(cmd, `msg-b-${crypto.randomUUID()}`);
    await waitFor(async () => (await inboxRows()) === "2", { what: "second inbox row" });
    await waitQueueEmpty();

    expect(await debits()).toBe("1");
    expect(await scalar(`SELECT count(*)::text AS v FROM wager_transactions WHERE kind = 'BET'`)).toBe("1");
    expect(await receiveAll(WAGER_DLQ)).toHaveLength(0);
  });

  test("a BET without funds is stored REJECTED and acknowledged, not sent to the DLQ", async () => {
    await startConsumer();
    const cmd = bet("5000.00");
    await sendWager(cmd);
    await waitProcessed(cmd.externalTransactionId);
    await waitQueueEmpty();

    expect(await txStatus(cmd.externalTransactionId)).toBe("REJECTED");
    expect(await debits()).toBe("0");
    expect(await receiveAll(WAGER_DLQ)).toHaveLength(0);
  });

  test("a reference that has not arrived is PENDING_REFERENCE and acknowledged", async () => {
    await startConsumer();
    const refund = bet("25.00", { kind: "REFUND" as never, referenceExternalTransactionId: "bet-never-seen" });
    await sendWager(refund);
    await waitProcessed(refund.externalTransactionId);
    await waitQueueEmpty();
    expect(await txStatus(refund.externalTransactionId)).toBe("PENDING_REFERENCE");
    expect(await receiveAll(WAGER_DLQ)).toHaveLength(0);
  });

  test("a conflict (same key, other amount) is acknowledged and writes no row", async () => {
    await startConsumer();
    const cmd = bet();
    await sendWager(cmd);
    await waitProcessed(cmd.externalTransactionId);
    await waitQueueEmpty();

    await sendWager({ ...cmd, money: { amount: "26.00", currency: "BRL" } });
    await waitFor(async () => (await inboxRows()) === "2", { what: "conflict message consumed" });
    await waitQueueEmpty();
    expect(await scalar(`SELECT count(*)::text AS v FROM wager_transactions WHERE kind = 'BET'`)).toBe("1");
    expect(await receiveAll(WAGER_DLQ)).toHaveLength(0);
  });
});

describe("SQS consumer: permanent failures go to the DLQ", () => {
  test("malformed JSON goes to the DLQ with a reason attribute and the main queue ends empty (no retry loop)", async () => {
    await startConsumer();
    await sendRaw("{not json", wallet.walletId);
    await waitFor(async () => (await queueDepth(WAGER_DLQ)) > 0, { what: "message in DLQ" });
    await waitQueueEmpty();

    const dead = await receiveAll(WAGER_DLQ);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.body).toBe("{not json");
    expect(dead[0]!.attributes["reason"]).toBe("MALFORMED_JSON");
    expect(await inboxRows()).toBe("0");
  });

  test("valid JSON with an invalid payload / invalid money goes to the DLQ with the matching reason", async () => {
    await startConsumer();
    const badWallet = JSON.stringify({
      messageId: "m-bad-1", type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
      data: { ...bet(), walletId: "not-a-uuid" },
    });
    const badMoney = JSON.stringify({
      messageId: "m-bad-2", type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
      data: { ...bet(), money: { amount: "25", currency: "BRL" } },
    });
    const noEnvelope = JSON.stringify({ hello: "world" });
    await sendRaw(badWallet, wallet.walletId);
    await sendRaw(badMoney, wallet.walletId);
    await sendRaw(noEnvelope, wallet.walletId);
    await waitFor(async () => (await queueDepth(WAGER_DLQ)) >= 3, { what: "3 messages in DLQ" });
    await waitQueueEmpty();

    const reasons = (await receiveAll(WAGER_DLQ)).map((m) => m.attributes["reason"]).sort();
    expect(reasons).toEqual(["INVALID_MONEY", "INVALID_PAYLOAD", "INVALID_PAYLOAD"]);
    expect(await scalar(`SELECT count(*)::text AS v FROM wager_transactions WHERE kind = 'BET'`)).toBe("0");
  });
});

describe("SQS consumer: transient failures retry then redrive", () => {
  test("PostgreSQL down: message keeps coming back (retries counted) and lands in the DLQ after 5 receives", async () => {
    const broken = await startConsumer({
      DATABASE_URL: "postgres://wagering_app:app@localhost:5999/wagering",
      CONSUMER_VISIBILITY_TIMEOUT_SECONDS: "2",
    });
    const cmd = bet();
    await sendWager(cmd);

    await waitFor(async () => (await queueDepth(WAGER_DLQ)) > 0, { timeoutMs: 60_000, what: "redrive to DLQ" });

    const metrics = await (await fetch(`${broken.baseUrl}/metrics`)).text();
    const retries = Number(/retries_total\{component="consumer"\} (\d+)/.exec(metrics)?.[1] ?? 0);
    expect(retries).toBeGreaterThanOrEqual(4);

    const dead = await receiveAll(WAGER_DLQ);
    expect(dead).toHaveLength(1);
    expect(JSON.parse(dead[0]!.body).data.externalTransactionId).toBe(cmd.externalTransactionId);
    // Nada foi gravado: o banco de verdade (outro endereço) nunca viu a transação.
    expect(await scalar(`SELECT count(*)::text AS v FROM wager_transactions WHERE kind = 'BET'`)).toBe("0");
  }, 90_000);
});

describe("SQS consumer: graceful shutdown", () => {
  test("close() with a slow message in flight waits for it: PROCESSED and acknowledged", async () => {
    process.env.TEST_SLOW_MS = "2000";
    const app = await startConsumer();
    const cmd = bet();
    await sendWager(cmd);
    // Espera a mensagem estar em voo (recebida e dormindo no hook lento), ainda sem transação.
    await waitFor(async () => (await queueDepth(WAGER_QUEUE)) === 1 && (await queueInFlight()) === 1, { what: "message in flight" });
    expect(await txStatus(cmd.externalTransactionId).catch(() => "none")).toBe("none");

    await app.close();
    expect(await txStatus(cmd.externalTransactionId)).toBe("PROCESSED");
    expect(await queueDepth(WAGER_QUEUE)).toBe(0);
  }, 30_000);

  test("when the grace period expires the message is handed back with visibility 0", async () => {
    process.env.TEST_SLOW_MS = "4000";
    const app = await startConsumer({ SHUTDOWN_GRACE_MS: "300" });
    const cmd = bet();
    await sendWager(cmd);
    await waitFor(async () => (await queueInFlight()) === 1, { what: "message in flight" });

    await app.close();
    // Visível de novo logo, sem esperar o visibility timeout de 30 s.
    await waitFor(async () => (await queueVisible()) === 1, { timeoutMs: 5_000, what: "message visible again" });
  }, 30_000);

  test.skipIf(process.platform === "win32")(
    "SIGTERM to a spawned consumer with a slow message in flight: exit code 0 after finishing it",
    async () => {
      const proc = await spawnApp({
        port: Number(process.env.TEST_PORT_BASE ?? 4101) + 10,
        roles: "consumer",
        env: { TEST_SLOW_MS: "2000", CONSUMER_WAIT_SECONDS: "1", NODE_ENV: "test" },
      });
      const cmd = bet();
      await sendWager(cmd);
      await waitFor(async () => (await queueInFlight()) === 1, { what: "message in flight" });

      const code = await proc.kill("SIGTERM");
      expect(code).toBe(0);
      expect(await txStatus(cmd.externalTransactionId)).toBe("PROCESSED");
      expect(await queueDepth(WAGER_QUEUE)).toBe(0);
    },
    60_000,
  );
});

describe("SQS consumer: crash between commit and ack", () => {
  test("exit_after_commit: the process dies after the commit, the message comes back and the inbox keeps a single debit", async () => {
    const proc = await spawnApp({
      port: Number(process.env.TEST_PORT_BASE ?? 4101) + 11,
      roles: "consumer",
      env: {
        FAULT_INJECT: "exit_after_commit",
        NODE_ENV: "test",
        CONSUMER_WAIT_SECONDS: "1",
        CONSUMER_VISIBILITY_TIMEOUT_SECONDS: "3",
      },
    });
    const cmd = bet();
    await sendWager(cmd);

    expect(await proc.waitExit()).toBe(137);
    expect(await txStatus(cmd.externalTransactionId)).toBe("PROCESSED");
    expect(await debits()).toBe("1");
    expect(await queueDepth(WAGER_QUEUE)).toBe(1); // sem ack

    await startConsumer({ CONSUMER_VISIBILITY_TIMEOUT_SECONDS: "3" });
    await waitQueueEmpty();
    expect(await debits()).toBe("1");
    expect(await inboxRows()).toBe("1");
    expect(await receiveAll(WAGER_DLQ)).toHaveLength(0);
  }, 60_000);
});

// Contadores por atributo: queueDepth soma tudo; aqui separamos visíveis e em voo.
async function queueAttr(name: "ApproximateNumberOfMessages" | "ApproximateNumberOfMessagesNotVisible"): Promise<number> {
  const res = await sqsClient.send(
    new GetQueueAttributesCommand({ QueueUrl: await queueUrl(WAGER_QUEUE), AttributeNames: [name] }),
  );
  return Number(res.Attributes?.[name] ?? 0);
}
const queueVisible = () => queueAttr("ApproximateNumberOfMessages");
const queueInFlight = () => queueAttr("ApproximateNumberOfMessagesNotVisible");
