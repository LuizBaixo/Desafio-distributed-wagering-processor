import { describe, expect, test } from "bun:test";
import type { Clock } from "../../../src/application/ports/clock";
import type { Logger } from "../../../src/application/ports/logger";
import type { Metrics } from "../../../src/application/ports/metrics";
import type { BatchEntry, BatchResult, QueuePort } from "../../../src/application/ports/queue";
import type { OutboxRepository } from "../../../src/application/ports/repositories";
import type { TransactionScope, UnitOfWork } from "../../../src/application/ports/unit-of-work";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { OutboxPublisher } from "../../../src/interfaces/workers/outbox-publisher";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const clock: Clock = { now: () => NOW };
const silent: Logger = { info() {}, warn() {}, error() {} };

function makeMessages(n: number): OutboxMessage[] {
  return Array.from({ length: n }, (_, i) =>
    OutboxMessage.rehydrate({
      id: `msg-${String(i).padStart(3, "0")}`,
      aggregateId: "wallet-1",
      eventType: "T",
      payload: { i },
      occurredAt: new Date(NOW.getTime() - 60_000 + i),
      attempts: 0,
      nextAttemptAt: new Date(NOW.getTime() - 60_000),
    }),
  );
}

class FakeOutbox implements OutboxRepository {
  readonly publishedMany: string[][] = [];
  readonly released: Array<{ id: string; attempts: number }> = [];
  readonly dead: Array<{ id: string; attempts: number; error: string | undefined }> = [];
  private readonly pending: OutboxMessage[];
  constructor(messages: OutboxMessage[]) {
    this.pending = [...messages];
  }
  async enqueue(): Promise<void> {}
  async claimDue(limit: number): Promise<OutboxMessage[]> {
    return this.pending.splice(0, limit);
  }
  async markPublished(): Promise<void> {
    throw new Error("publisher must use markPublishedMany");
  }
  async markPublishedMany(ids: string[]): Promise<number> {
    this.publishedMany.push([...ids]);
    return ids.length;
  }
  async release(m: OutboxMessage): Promise<void> {
    this.released.push({ id: m.id, attempts: m.attempts });
  }
  async markDead(m: OutboxMessage): Promise<void> {
    this.dead.push({ id: m.id, attempts: m.attempts, error: m.lastError });
  }
  async oldestPendingAgeSeconds(): Promise<number> {
    return 0;
  }
  async purgePublishedBefore(): Promise<number> {
    return 0;
  }
}

function fakeUow(outbox: OutboxRepository): UnitOfWork {
  return { run: (work) => work({ outbox } as unknown as TransactionScope) };
}

const deadMetric = { count: 0 };

function fakeMetrics(retries: string[]): Metrics {
  return {
    outboxDead: () => void deadMetric.count++,
    transaction() {},
    duplicate() {},
    retry: (c: string) => void retries.push(c),
    dlq() {},
    lockConflict() {},
    setOutboxLag() {},
    observeProcessing() {},
    reconciliationMismatch() {},
      reconciliationRun() {},
    reconciliationError() {},
  } as unknown as Metrics;
}

function fakeQueue(sendBatch: (queue: string, entries: BatchEntry[]) => Promise<BatchResult>): QueuePort {
  return {
    receive: async () => [],
    delete: async () => {},
    changeVisibility: async () => {},
    send: async () => {
      throw new Error("publisher must use sendBatch");
    },
    sendBatch,
    ping: async () => {},
  };
}

function publisher(outbox: FakeOutbox, queue: QueuePort, retries: string[], options: { batchSize?: number; sendBatchSize?: number; maxAttempts?: number } = {}) {
  return new OutboxPublisher(fakeUow(outbox), queue, clock, fakeMetrics(retries), silent, {
    queueName: "events.fifo",
    pollMs: 10,
    enabled: false,
    ...options,
  });
}

describe("OutboxPublisher: envio em lote", () => {
  test("25 mensagens pendentes viram 3 chamadas sendBatch com tamanhos [10, 10, 5]", async () => {
    const outbox = new FakeOutbox(makeMessages(25));
    const sizes: number[] = [];
    const queue = fakeQueue(async (_q, entries) => {
      sizes.push(entries.length);
      return { ok: entries.map((e) => e.id), failed: [] };
    });

    const published = await publisher(outbox, queue, []).tick();

    expect(sizes).toEqual([10, 10, 5]);
    expect(published).toBe(25);
    expect(outbox.publishedMany.map((ids) => ids.length)).toEqual([10, 10, 5]);
    expect(outbox.released).toEqual([]);
  });

  test("entradas carregam groupId = aggregateId e dedupId = id", async () => {
    const outbox = new FakeOutbox(makeMessages(2));
    let seen: BatchEntry[] = [];
    const queue = fakeQueue(async (_q, entries) => {
      seen = entries;
      return { ok: entries.map((e) => e.id), failed: [] };
    });

    await publisher(outbox, queue, []).tick();

    expect(seen.map((e) => [e.id, e.groupId, e.dedupId])).toEqual([
      ["msg-000", "wallet-1", "msg-000"],
      ["msg-001", "wallet-1", "msg-001"],
    ]);
    expect(JSON.parse(seen[0]!.body)).toEqual({ i: 0 });
  });

  test("falha parcial: só os ok são marcados; os failed recebem scheduleRetry + release (attempts 1) e retry('outbox')", async () => {
    const msgs = makeMessages(10);
    const failedIds = [msgs[3]!.id, msgs[7]!.id];
    const outbox = new FakeOutbox(msgs);
    const retries: string[] = [];
    const queue = fakeQueue(async (_q, entries) => ({
      ok: entries.filter((e) => !failedIds.includes(e.id)).map((e) => e.id),
      failed: failedIds.map((id) => ({ id, code: "InternalError" })),
    }));

    const published = await publisher(outbox, queue, retries).tick();

    expect(published).toBe(8);
    expect(outbox.publishedMany).toHaveLength(1);
    expect(outbox.publishedMany[0]).toHaveLength(8);
    expect(outbox.publishedMany[0]).not.toContain(failedIds[0]!);
    expect(outbox.publishedMany[0]).not.toContain(failedIds[1]!);
    expect(outbox.released).toEqual(failedIds.map((id) => ({ id, attempts: 1 })));
    expect(retries).toEqual(["outbox", "outbox"]);
  });

  test("sendBatch que lança: o lote inteiro vai para retry e os outros lotes do tick continuam", async () => {
    const msgs = makeMessages(25);
    const outbox = new FakeOutbox(msgs);
    const retries: string[] = [];
    let call = 0;
    const queue = fakeQueue(async (_q, entries) => {
      if (call++ === 0) throw new Error("sqs down");
      return { ok: entries.map((e) => e.id), failed: [] };
    });

    const published = await publisher(outbox, queue, retries).tick();

    expect(call).toBe(3);
    expect(published).toBe(15);
    expect(outbox.released).toEqual(msgs.slice(0, 10).map((m) => ({ id: m.id, attempts: 1 })));
    expect(retries).toHaveLength(10);
    expect(outbox.publishedMany.map((ids) => ids.length)).toEqual([10, 5]);
  });

  test("markPublishedMany que lança não derruba o tick nem conta como publicado", async () => {
    const outbox = new FakeOutbox(makeMessages(12));
    let marks = 0;
    outbox.markPublishedMany = async (ids) => {
      if (marks++ === 0) throw new Error("db down");
      return ids.length;
    };
    const queue = fakeQueue(async (_q, entries) => ({ ok: entries.map((e) => e.id), failed: [] }));

    const published = await publisher(outbox, queue, []).tick();

    expect(published).toBe(2);
    expect(outbox.released).toEqual([]);
  });

  test("batchSize limita o claim e sendBatchSize o tamanho de cada envio", async () => {
    const outbox = new FakeOutbox(makeMessages(30));
    const sizes: number[] = [];
    const queue = fakeQueue(async (_q, entries) => {
      sizes.push(entries.length);
      return { ok: entries.map((e) => e.id), failed: [] };
    });

    const published = await publisher(outbox, queue, [], { batchSize: 12, sendBatchSize: 5 }).tick();

    expect(published).toBe(12);
    expect(sizes).toEqual([5, 5, 2]);
  });

  test("shouldStop interrompe entre lotes (o resto fica com o lease)", async () => {
    const outbox = new FakeOutbox(makeMessages(25));
    const sizes: number[] = [];
    const queue = fakeQueue(async (_q, entries) => {
      sizes.push(entries.length);
      return { ok: entries.map((e) => e.id), failed: [] };
    });
    let calls = 0;

    const published = await publisher(outbox, queue, []).tick({ shouldStop: () => calls++ >= 1 });

    expect(sizes).toEqual([10]);
    expect(published).toBe(10);
  });
});

describe("OutboxPublisher: limite de bytes por lote", () => {
  const KIB = 1024;
  function sized(id: string, bytes: number, i: number, char = "x"): OutboxMessage {
    const overhead = Buffer.byteLength('{"pad":""}', "utf8");
    const unit = Buffer.byteLength(char, "utf8");
    return OutboxMessage.rehydrate({
      id,
      aggregateId: "wallet-1",
      eventType: "T",
      payload: { pad: char.repeat(Math.floor((bytes - overhead) / unit)) },
      occurredAt: new Date(NOW.getTime() - 60_000 + i),
      attempts: 0,
      nextAttemptAt: new Date(NOW.getTime() - 60_000),
    });
  }

  test("10 entradas de 30 KiB viram 2 chunks (8 + 2): nenhum envio passa de 262144 bytes", async () => {
    const msgs = Array.from({ length: 10 }, (_, i) => sized(`big-${i}`, 30 * KIB, i));
    const calls: Array<{ count: number; bytes: number }> = [];
    const queue = fakeQueue(async (_q, entries) => {
      calls.push({ count: entries.length, bytes: entries.reduce((a, e) => a + Buffer.byteLength(e.body, "utf8"), 0) });
      return { ok: entries.map((e) => e.id), failed: [] };
    });

    const published = await publisher(new FakeOutbox(msgs), queue, []).tick();

    expect(published).toBe(10);
    expect(calls.map((c) => c.count)).toEqual([8, 2]);
    for (const c of calls) expect(c.bytes).toBeLessThanOrEqual(262_144);
  });

  test("conta bytes UTF-8, não caracteres", async () => {
    // 3 entradas de ~100 KB em UTF-8 (caracteres de 2 bytes): só 2 cabem em 262144 bytes.
    const msgs = Array.from({ length: 3 }, (_, i) => sized(`utf-${i}`, 100_000, i, "é"));
    const sizes: number[] = [];
    const queue = fakeQueue(async (_q, entries) => {
      sizes.push(entries.length);
      return { ok: entries.map((e) => e.id), failed: [] };
    });

    await publisher(new FakeOutbox(msgs), queue, []).tick();

    expect(sizes).toEqual([2, 1]);
  });

  test("entrada sozinha acima do limite segue isolada, e as vizinhas não são arrastadas", async () => {
    const msgs = [sized("before", KIB, 0), sized("huge", 262_145, 1), sized("after", KIB, 2)];
    const seen: string[][] = [];
    const queue = fakeQueue(async (_q, entries) => {
      seen.push(entries.map((e) => e.id));
      return { ok: entries.map((e) => e.id), failed: [] };
    });

    await publisher(new FakeOutbox(msgs), queue, []).tick();

    expect(seen).toEqual([["before"], ["huge"], ["after"]]);
  });
});

describe("OutboxPublisher: falha permanente (dead letter)", () => {
  function withAttempts(id: string, attempts: number, i = 0): OutboxMessage {
    return OutboxMessage.rehydrate({
      id,
      aggregateId: "wallet-1",
      eventType: "T",
      payload: { id },
      occurredAt: new Date(NOW.getTime() - 60_000 + i),
      attempts,
      nextAttemptAt: new Date(NOW.getTime() - 60_000),
    });
  }

  test.each(["BODY_TOO_LARGE", "InvalidParameterValue", "InvalidMessageContents", "UnsupportedOperation"])(
    "código permanente %s grava dead sem retry, e o resto do lote é publicado",
    async (code) => {
      deadMetric.count = 0;
      const outbox = new FakeOutbox([withAttempts("bad", 0, 0), withAttempts("good", 0, 1)]);
      const retries: string[] = [];
      const queue = fakeQueue(async (_q, entries) => ({
        ok: entries.filter((e) => e.id !== "bad").map((e) => e.id),
        failed: [{ id: "bad", code }],
      }));

      const published = await publisher(outbox, queue, retries).tick();

      expect(published).toBe(1);
      expect(outbox.dead).toEqual([{ id: "bad", attempts: 0, error: code }]);
      expect(outbox.released).toEqual([]);
      expect(retries).toEqual([]);
      expect(deadMetric.count).toBe(1);
    },
  );

  test("código transitório com attempts abaixo do limite continua em retry", async () => {
    deadMetric.count = 0;
    const outbox = new FakeOutbox([withAttempts("m", 48)]);
    const queue = fakeQueue(async () => ({ ok: [], failed: [{ id: "m", code: "InternalError" }] }));

    await publisher(outbox, queue, [], { maxAttempts: 50 }).tick();

    expect(outbox.released).toEqual([{ id: "m", attempts: 49 }]);
    expect(outbox.dead).toEqual([]);
    expect(deadMetric.count).toBe(0);
  });

  test("attempts que chega ao limite (OUTBOX_MAX_ATTEMPTS) vira dead com o último código", async () => {
    deadMetric.count = 0;
    const outbox = new FakeOutbox([withAttempts("m", 49)]);
    const retries: string[] = [];
    const queue = fakeQueue(async () => ({ ok: [], failed: [{ id: "m", code: "InternalError" }] }));

    await publisher(outbox, queue, retries, { maxAttempts: 50 }).tick();

    expect(outbox.dead).toEqual([{ id: "m", attempts: 50, error: "InternalError" }]);
    expect(outbox.released).toEqual([]);
    expect(retries).toEqual([]);
    expect(deadMetric.count).toBe(1);
  });

  test("sendBatch que lança também conta para o limite de tentativas", async () => {
    const outbox = new FakeOutbox([withAttempts("m", 2)]);
    const queue = fakeQueue(async () => {
      throw new Error("sqs down");
    });

    await publisher(outbox, queue, [], { maxAttempts: 3 }).tick();

    expect(outbox.dead).toEqual([{ id: "m", attempts: 3, error: "Error" }]);
  });
});

describe("OutboxPublisher: agendamento após lote cheio", () => {
  test("250 pendentes com batch 100 são publicados em menos de 1 s, sem esperar pollMs (10 s)", async () => {
    const outbox = new FakeOutbox(makeMessages(250));
    const queue = fakeQueue(async (_q, entries) => ({ ok: entries.map((e) => e.id), failed: [] }));
    const pub = new OutboxPublisher(fakeUow(outbox), queue, clock, fakeMetrics([]), silent, {
      queueName: "events.fifo",
      pollMs: 10_000,
      enabled: true,
      batchSize: 100,
    });

    const start = performance.now();
    pub.onApplicationBootstrap();
    const deadline = start + 1000;
    while (outbox.publishedMany.flat().length < 250 && performance.now() < deadline) {
      await Bun.sleep(5);
    }
    const elapsed = performance.now() - start;
    await pub.beforeApplicationShutdown();

    expect(outbox.publishedMany.flat()).toHaveLength(250);
    expect(elapsed).toBeLessThan(1000);
  });
});
