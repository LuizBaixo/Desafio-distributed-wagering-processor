import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { getTracing } from "../../src/application/ports/tracing";
import { initTracing } from "../../src/infrastructure/observability/tracing";
import { OutboxPublisher } from "../../src/interfaces/workers/outbox-publisher";
import { closePools, migrateUp, resetDb } from "../helpers/db";
import { buildEnvelope, EVENTS_QUEUE, purgeAll, queueUrl, receiveAll, sqsClient, waitFor, WAGER_QUEUE } from "../helpers/sqs";
import { buildWagerCommand, createWalletDirect } from "../helpers/factories";
import { startTestApp, type TestApp } from "../helpers/http";
import { postWager } from "../helpers/wager-http";

const exporter = new InMemorySpanExporter();
let shutdownTracing: () => Promise<void>;
let app: TestApp;

const spans = (name: string): ReadableSpan[] => exporter.getFinishedSpans().filter((s) => s.name === name);
const parentId = (s: ReadableSpan): string | undefined => s.parentSpanContext?.spanId;
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;

beforeAll(async () => {
  await migrateUp();
  ({ shutdown: shutdownTracing } = await initTracing({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
  app = await startTestApp();
});
beforeEach(async () => {
  await resetDb();
  exporter.reset();
});
afterAll(async () => {
  await app.close();
  await shutdownTracing();
  await closePools();
});

describe("HTTP", () => {
  test("wager.submit is a child of http.request, db.transaction a child of wager.submit, with the expected attributes", async () => {
    const w = await createWalletDirect("100.00");
    const cmd = buildWagerCommand({ walletId: w.walletId, playerId: w.playerId });

    const res = await postWager(app.baseUrl, cmd);
    expect(res.status).toBe(200);

    const http = spans("http.request");
    const submit = spans("wager.submit");
    expect(http).toHaveLength(1);
    expect(submit).toHaveLength(1);
    expect(parentId(submit[0]!)).toBe(http[0]!.spanContext().spanId);
    expect(submit[0]!.spanContext().traceId).toBe(http[0]!.spanContext().traceId);
    expect(submit[0]!.attributes).toMatchObject({
      "transaction.id": res.body.transactionId,
      "wallet.id": w.walletId,
      "provider.id": cmd.providerId,
      outcome: "processed",
      source: "http",
    });
    const tx = spans("db.transaction");
    expect(tx.length).toBeGreaterThan(0);
    expect(tx.some((s) => parentId(s) === submit[0]!.spanContext().spanId)).toBe(true);
  });

  test("no span carries a monetary attribute (key or value)", async () => {
    const w = await createWalletDirect("100.00");
    const cmd = buildWagerCommand({ walletId: w.walletId, playerId: w.playerId, money: { amount: "37.41", currency: "BRL" } });
    await postWager(app.baseUrl, cmd);

    const all = exporter.getFinishedSpans();
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) {
      for (const [k, v] of Object.entries(s.attributes)) {
        expect(k).not.toMatch(/amount|money|balance|currency|stake/i);
        expect(String(v)).not.toContain("37.41");
        expect(String(v)).not.toMatch(/^\d+\.\d{2}$/);
      }
    }
  });
});

describe("SQS", () => {
  test("sqs.process continues the traceparent of the message attribute; wager.submit has source sqs", async () => {
    await purgeAll();
    const on = await startTestApp({ APP_ROLES: "api,consumer" });
    try {
      const w = await createWalletDirect("100.00");
      const cmd = buildWagerCommand({ walletId: w.walletId, playerId: w.playerId });
      const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
      const parentSpan = "00f067aa0ba902b7";
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: await queueUrl(WAGER_QUEUE),
          MessageBody: buildEnvelope(cmd, crypto.randomUUID()),
          MessageGroupId: cmd.walletId,
          MessageDeduplicationId: crypto.randomUUID(),
          MessageAttributes: { traceparent: { DataType: "String", StringValue: `00-${traceId}-${parentSpan}-01` } },
        }),
      );

      await waitFor(async () => spans("sqs.process").length > 0 && spans("wager.submit").length > 0, {
        what: "sqs.process span",
      });

      const proc = spans("sqs.process")[0]!;
      expect(proc.spanContext().traceId).toBe(traceId);
      expect(parentId(proc)).toBe(parentSpan);
      const submit = spans("wager.submit")[0]!;
      expect(parentId(submit)).toBe(proc.spanContext().spanId);
      expect(submit.attributes["source"]).toBe("sqs");
      expect(spans("sqs.receive").length).toBeGreaterThan(0);
    } finally {
      await on.close();
      await purgeAll();
    }
  });
});

describe("outbox", () => {
  test("outbox.publish_batch span; the event message carries a traceparent attribute and the payload is untouched", async () => {
    await purgeAll();
    const w = await createWalletDirect("100.00");
    await postWager(app.baseUrl, buildWagerCommand({ walletId: w.walletId, playerId: w.playerId }));
    exporter.reset();

    const publisher = (app.app as INestApplication).get(OutboxPublisher);
    expect(await publisher.tick()).toBeGreaterThan(0);

    const batch = spans("outbox.publish_batch");
    expect(batch.length).toBeGreaterThan(0);
    const msgs = await receiveAll(EVENTS_QUEUE, 2);
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) {
      expect(m.attributes["traceparent"]).toMatch(TRACEPARENT);
      expect(m.body).not.toContain("traceparent");
    }
    expect(batch.map((s) => s.spanContext().traceId)).toContain(msgs[0]!.attributes["traceparent"]!.split("-")[1]!);
  });
});

describe("no-op", () => {
  test("without the SDK the default tracing does nothing and returns the callback value", async () => {
    const { NOOP_TRACING } = await import("../../src/application/ports/tracing");
    expect(NOOP_TRACING.currentTraceparent()).toBeUndefined();
    expect(await NOOP_TRACING.withSpan("x", { a: 1 }, async (span) => (span.setAttribute("k", "v"), 42))).toBe(42);
    expect(getTracing()).not.toBe(NOOP_TRACING); // initTracing no beforeAll
  });
});
