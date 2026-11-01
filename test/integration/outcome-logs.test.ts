import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { QueuePort } from "../../src/application/ports/queue";
import { ReprocessPendingReferences } from "../../src/application/wagering/reprocess-pending-references";
import { WagerEngine } from "../../src/application/wagering/wager-engine";
import { WagerTransactionKind as Kind } from "../../src/domain/wagering/enums";
import { OutboxPublisher } from "../../src/interfaces/workers/outbox-publisher";
import { SystemClock } from "../../src/infrastructure/system/clock";
import { Uuid7Generator } from "../../src/infrastructure/system/uuid-generator";
import { CaptureLogger } from "../helpers/capture-logger";
import { closePools, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { buildWagerCommand, createWalletDirect } from "../helpers/factories";
import { buildWagerHarness, type WagerHarness } from "../helpers/wager-harness";

let h: WagerHarness;
let log: CaptureLogger;

beforeAll(async () => {
  await migrateUp();
});
beforeEach(async () => {
  await resetDb();
  log = new CaptureLogger();
  h = await buildWagerHarness(undefined, { logger: log });
});
afterAll(async () => {
  await closePools();
});

const outcomes = () => log.at("info").filter((e) => e.msg === "wager outcome");

describe("SubmitWagerTransaction outcome logs", () => {
  test("HTTP success logs one info line with ids, status and context, no money", async () => {
    const w = await createWalletDirect("1000.00");
    const cmd = buildWagerCommand({ walletId: w.walletId, playerId: w.playerId });
    const r = await h.submit.execute(cmd, { correlationId: "corr-1" });
    await h.close();

    expect(outcomes()).toHaveLength(1);
    const line = outcomes()[0]!.obj;
    expect(line).toMatchObject({
      status: "PROCESSED",
      failureCode: null,
      kind: "BET",
      source: "http",
      idempotentReplay: false,
      correlationId: "corr-1",
      walletId: w.walletId,
      providerId: cmd.providerId,
    });
    expect(line.transactionId).toBe((r as { view: { transactionId: string } }).view.transactionId);
    expect(log.dump()).not.toMatch(/amount|balance|975\.00|25\.00/i);
  });

  test("SQS source, replay flag and conflict are logged", async () => {
    const w = await createWalletDirect("1000.00");
    const cmd = buildWagerCommand({ walletId: w.walletId, playerId: w.playerId });
    const inbox = (id: string) => ({ consumerName: "c", messageId: id, payloadHash: "h" });
    await h.submit.execute(cmd, { correlationId: "m1", inbox: inbox("m1") });
    await h.submit.execute(cmd, { correlationId: "m2", inbox: inbox("m2") });
    await h.submit.execute({ ...cmd, roundId: "other" }, { correlationId: "m3", inbox: inbox("m3") });
    await h.close();

    const [first, replay, conflict] = outcomes().map((e) => e.obj);
    expect(first).toMatchObject({ source: "sqs", messageId: "m1", idempotentReplay: false, status: "PROCESSED" });
    expect(replay).toMatchObject({ source: "sqs", messageId: "m2", idempotentReplay: true, status: "PROCESSED" });
    expect(conflict).toMatchObject({
      source: "sqs",
      messageId: "m3",
      status: "CONFLICT",
      failureCode: "IDEMPOTENCY_CONFLICT",
    });
    expect(log.dump()).not.toMatch(/amount|balance/i);
  });

  test("rejected wager logs failureCode", async () => {
    const w = await createWalletDirect("10.00");
    await h.submit.execute(buildWagerCommand({ walletId: w.walletId, playerId: w.playerId }), { correlationId: "c" });
    await h.close();
    expect(outcomes()[0]!.obj).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
  });
});

describe("inbox payload mismatch", () => {
  test("same messageId with another hash: acked as duplicate, warn log, duplicates_detected_total{inbox,conflict}", async () => {
    const w = await createWalletDirect("1000.00");
    const cmd = buildWagerCommand({ walletId: w.walletId, playerId: w.playerId });
    const inbox = (payloadHash: string) => ({ consumerName: "c", messageId: "same-id", payloadHash });
    await h.submit.execute(cmd, { correlationId: "same-id", inbox: inbox("a".repeat(64)) });
    const dup = await h.submit.execute(cmd, { correlationId: "same-id", inbox: inbox("b".repeat(64)) });
    const same = await h.submit.execute(cmd, { correlationId: "same-id", inbox: inbox("a".repeat(64)) });
    expect(dup).toMatchObject({ kind: "duplicateMessage" });
    expect(same).toMatchObject({ kind: "duplicateMessage" });

    const metrics = await h.metrics.registry.metrics();
    expect(metrics).toContain('duplicates_detected_total{source="inbox",result="conflict"} 1');
    expect(metrics).toContain('duplicates_detected_total{source="inbox",result="message"} 1');
    const warns = log.at("warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj).toMatchObject({ messageId: "same-id", walletId: w.walletId, providerId: cmd.providerId });
    expect(log.dump()).not.toMatch(/amount|balance/i);
    await h.close();
    expect(await ownerPool().query(`SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [w.walletId])).toHaveProperty("rowCount", 1);
  });
});

describe("pending worker outcome logs", () => {
  test("logs one line per resolved item", async () => {
    const w = await createWalletDirect("1000.00");
    const bet = buildWagerCommand({ walletId: w.walletId, playerId: w.playerId });
    const refund = buildWagerCommand({
      walletId: w.walletId,
      playerId: w.playerId,
      kind: Kind.Refund,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const pending = await h.submit.execute(refund, { correlationId: "c" });
    expect(pending.kind).toBe("pending");
    await h.submit.execute(bet, { correlationId: "c2" });
    log.entries.length = 0;

    const worker = new ReprocessPendingReferences(
      h.uow,
      new WagerEngine(new Uuid7Generator(), new SystemClock()),
      new SystemClock(),
      new Uuid7Generator(),
      log,
      h.metrics,
      { maxAttempts: 10 },
    );
    expect(await worker.tick()).toBe(1);
    await h.close();

    const lines = log.at("info").filter((e) => e.msg === "pending reference outcome");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.obj).toMatchObject({
      status: "PROCESSED",
      kind: "REFUND",
      source: "pending",
      idempotentReplay: false,
      walletId: w.walletId,
      providerId: refund.providerId,
    });
    expect(typeof lines[0]!.obj.transactionId).toBe("string");
    expect(typeof lines[0]!.obj.correlationId).toBe("string");
    expect(log.dump()).not.toMatch(/amount|balance/i);
  });
});

describe("outbox publisher batch log", () => {
  test("one line per non-empty batch with published and failed counts", async () => {
    let n = 0;
    const queue = {
      async send() {
        if (n++ === 1) throw new Error("sqs down");
      },
    } as unknown as QueuePort;
    for (let i = 0; i < 3; i++) {
      const id = crypto.randomUUID();
      await ownerPool().query(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
         VALUES ($1, $2, 'T', $3::jsonb, now() - interval '1 minute', 0, now() - interval '1 minute')`,
        [id, "agg", JSON.stringify({ eventId: id })],
      );
    }
    const pub = new OutboxPublisher(h.uow, queue, new SystemClock(), h.metrics, log, {
      queueName: "q",
      pollMs: 10,
      enabled: false,
    });
    expect(await pub.tick()).toBe(2);
    log.entries.length = 0;
    expect(await pub.tick()).toBe(0); // o item que falhou está em backoff: lote vazio, sem linha
    await h.close();
    expect(log.at("info")).toHaveLength(0);
  });

  test("batch line carries claimed, published and failed", async () => {
    let n = 0;
    const queue = {
      async send() {
        if (n++ === 1) throw new Error("sqs down");
      },
    } as unknown as QueuePort;
    for (let i = 0; i < 3; i++) {
      const id = crypto.randomUUID();
      await ownerPool().query(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
         VALUES ($1, $2, 'T', $3::jsonb, now() - interval '1 minute', 0, now() - interval '1 minute')`,
        [id, "agg", JSON.stringify({ eventId: id })],
      );
    }
    const pub = new OutboxPublisher(h.uow, queue, new SystemClock(), h.metrics, log, {
      queueName: "q",
      pollMs: 10,
      enabled: false,
    });
    await pub.tick();
    await h.close();
    const lines = log.at("info").filter((e) => e.msg === "outbox batch published");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.obj).toMatchObject({ claimed: 3, published: 2, failed: 1 });
    expect(log.dump()).not.toMatch(/amount|balance/i);
  });
});
