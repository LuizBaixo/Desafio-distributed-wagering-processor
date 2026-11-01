import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { OutboxPublisher } from "../../src/interfaces/workers/outbox-publisher";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work";
import { CLOCK, METRICS, UNIT_OF_WORK } from "../../src/application/ports/tokens";
import type { Clock } from "../../src/application/ports/clock";
import type { Metrics } from "../../src/application/ports/metrics";
import { QUEUE_PORT, type QueuePort } from "../../src/application/ports/queue";
import type { UnitOfWork, TransactionScope } from "../../src/application/ports/unit-of-work";
import type { Logger } from "../../src/application/ports/logger";
import { assertLedgerConsistent } from "../helpers/assert-ledger-consistent";
import { closePools, createAppOrm, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { startTestApp, type TestApp } from "../helpers/http";
import { EVENTS_QUEUE, purgeAll, receiveAll } from "../helpers/sqs";

const PLAYER = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";
const silent: Logger = { error() {} };

let app: TestApp;
let container: INestApplication;

beforeAll(async () => {
  await migrateUp();
  app = await startTestApp();
  container = app.app as INestApplication;
});

beforeEach(async () => {
  await resetDb();
  await purgeAll();
});

afterEach(async () => {
  await assertLedgerConsistent();
});

afterAll(async () => {
  await app.close();
  await closePools();
});

function publisherFor(uow: UnitOfWork, queue: QueuePort = container.get<QueuePort>(QUEUE_PORT), metrics?: Metrics, logger: Logger = silent): OutboxPublisher {
  return new OutboxPublisher(uow, queue, container.get<Clock>(CLOCK), metrics ?? container.get<Metrics>(METRICS), logger, {
    queueName: "wallet-events.fifo",
    pollMs: 10,
    enabled: false,
  });
}

function appPublisher(): OutboxPublisher {
  return publisherFor(container.get<UnitOfWork>(UNIT_OF_WORK));
}

/** Insere eventos pendentes direto na outbox, como o caso de uso faria (mesma forma de linha). */
async function seedOutbox(n: number, aggregateId: string, eventType = "TestEvent"): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = crypto.randomUUID();
    ids.push(id);
    await ownerPool().query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       VALUES ($1, $2, $3, $4::jsonb, now(), 0, now())`,
      [id, aggregateId, eventType, JSON.stringify({ eventId: id, eventType, aggregateId, data: { i } })],
    );
  }
  return ids;
}

async function createWallet(amount: string): Promise<string> {
  const res = await fetch(`${app.baseUrl}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId: PLAYER, initialBalance: { amount, currency: "BRL" } }),
  });
  return ((await res.json()) as { id: string }).id;
}

describe("publisher da outbox", () => {
  test("depois de 1 BET, um tick publica 2 eventos em wallet-events.fifo com eventType certos e published_at preenchido", async () => {
    const walletId = await createWallet("100.00");
    const publisher = appPublisher();
    // Drena os eventos do OPENING antes de medir a BET.
    while ((await publisher.tick()) > 0) {
      // loop até zerar
    }
    await purgeAll();

    const bet = await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "provider-a:bet-pub-1" },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: "bet-pub-1",
        playerId: PLAYER,
        walletId,
        roundId: "round-1",
        gameId: "game-1",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
      }),
    });
    expect(bet.status).toBe(200);

    expect(await publisher.tick()).toBe(2);

    const received = (await receiveAll(EVENTS_QUEUE, 1))
      .map((m) => JSON.parse(m.body) as { aggregateId: string; eventType: string })
      .filter((b) => b.aggregateId === walletId)
      .map((b) => b.eventType)
      .sort();
    expect(received).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);

    const { rows } = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = $1 AND published_at IS NULL`,
      [walletId],
    );
    expect(rows[0]!.n).toBe(0);
  });

  test("dois publishers concorrentes sobre 200 eventos: cada um publicado uma vez, soma dos ticks = 200, nenhum published_at nulo", async () => {
    const aggregate = crypto.randomUUID();
    await seedOutbox(200, aggregate);

    // Dois publishers com pools separados (cada MikroORM tem o seu).
    const ormA: MikroORM = await createAppOrm();
    const ormB: MikroORM = await createAppOrm();
    try {
      const pubA = publisherFor(new MikroUnitOfWork(ormA.em));
      const pubB = publisherFor(new MikroUnitOfWork(ormB.em));

      let total = 0;
      for (;;) {
        const [a, b] = await Promise.all([pubA.tick(), pubB.tick()]);
        total += a + b;
        if (a + b === 0) break;
      }
      expect(total).toBe(200);

      const { rows } = await ownerPool().query<{ pending: number; published: number }>(
        `SELECT count(*) FILTER (WHERE published_at IS NULL)::int AS pending,
                count(*) FILTER (WHERE published_at IS NOT NULL)::int AS published
           FROM outbox_messages WHERE aggregate_id = $1`,
        [aggregate],
      );
      expect(rows[0]!.pending).toBe(0);
      expect(rows[0]!.published).toBe(200);
    } finally {
      await ormA.close(true);
      await ormB.close(true);
    }
  });

  test("crash entre publicar e marcar: lease curto expira e outro publisher republica; consumidor deduplica por eventId", async () => {
    const aggregate = crypto.randomUUID();
    const eventId = (await seedOutbox(1, aggregate, "CrashEvent"))[0]!;
    const real = container.get<UnitOfWork>(UNIT_OF_WORK);
    const queue = container.get<QueuePort>(QUEUE_PORT);

    // Publisher que "morre" depois do send: markPublished lança, como se o processo tivesse caído.
    const crashingUow: UnitOfWork = {
      run: <T>(work: (scope: TransactionScope) => Promise<T>) =>
        real.run<T>((scope) =>
          work({
            ...scope,
            outbox: {
              enqueue: scope.outbox.enqueue.bind(scope.outbox),
              claimDue: scope.outbox.claimDue.bind(scope.outbox),
              release: scope.outbox.release.bind(scope.outbox),
              oldestPendingAgeSeconds: scope.outbox.oldestPendingAgeSeconds.bind(scope.outbox),
              markPublished: async () => {
                throw new Error("simulated crash before markPublished");
              },
            },
          }),
        ),
    };

    const dying = publisherFor(crashingUow);
    expect(await dying.tick({ leaseSeconds: 1 })).toBe(0);

    const afterCrash = await ownerPool().query<{ published_at: Date | null }>(
      `SELECT published_at FROM outbox_messages WHERE id = $1`,
      [eventId],
    );
    expect(afterCrash.rows[0]!.published_at).toBeNull();

    // Lease de 1 s expira; outra instância assume.
    await Bun.sleep(1500);
    const survivor = publisherFor(real);
    expect(await survivor.tick()).toBe(1);

    const done = await ownerPool().query<{ published_at: Date | null }>(
      `SELECT published_at FROM outbox_messages WHERE id = $1`,
      [eventId],
    );
    expect(done.rows[0]!.published_at).not.toBeNull();

    // Consumidor de teste: pode receber a mesma mensagem duas vezes, mas conta um evento lógico.
    const seen = new Set<string>();
    for (const m of await receiveAll(EVENTS_QUEUE, 1)) {
      const body = JSON.parse(m.body) as { eventId: string; aggregateId: string };
      if (body.aggregateId === aggregate) seen.add(body.eventId);
    }
    expect([...seen]).toEqual([eventId]);
  });

  test("send falhando: attempts 1, next_attempt_at no futuro, published_at nulo, métrica retry('outbox')", async () => {
    const aggregate = crypto.randomUUID();
    const eventId = (await seedOutbox(1, aggregate))[0]!;
    const retries: string[] = [];
    const metrics = {
      transaction() {},
      duplicate() {},
      retry(component: string) {
        retries.push(component);
      },
      dlq() {},
      lockConflict() {},
      setOutboxLag() {},
      observeProcessing() {},
      reconciliationMismatch() {},
    } as unknown as Metrics;
    const brokenQueue: QueuePort = {
      receive: async () => [],
      delete: async () => {},
      changeVisibility: async () => {},
      send: async () => {
        throw new Error("endpoint SQS errado");
      },
      ping: async () => {},
    };

    const publisher = publisherFor(container.get<UnitOfWork>(UNIT_OF_WORK), brokenQueue, metrics);
    expect(await publisher.tick()).toBe(0);

    const { rows } = await ownerPool().query<{ attempts: number; next: Date; published_at: Date | null }>(
      `SELECT attempts, next_attempt_at AS next, published_at FROM outbox_messages WHERE id = $1`,
      [eventId],
    );
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.published_at).toBeNull();
    expect(rows[0]!.next.getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(retries).toEqual(["outbox"]);
  });

  test("loop não liga sem o papel outbox (APP_ROLES padrão = api)", () => {
    expect(container.get(OutboxPublisher).isRunning()).toBe(false);
  });
});

describe("papel outbox", () => {
  test("liga o loop, publica sozinho e para no shutdown", async () => {
    const on = await startTestApp({ APP_ROLES: "api,outbox", OUTBOX_POLL_MS: "50" });
    const publisher = (on.app as INestApplication).get(OutboxPublisher);
    try {
      expect(publisher.isRunning()).toBe(true);
      const aggregate = crypto.randomUUID();
      const [eventId] = await seedOutbox(1, aggregate);
      let published = false;
      for (let i = 0; i < 60 && !published; i++) {
        await Bun.sleep(50);
        const { rows } = await ownerPool().query<{ published_at: Date | null }>(
          `SELECT published_at FROM outbox_messages WHERE id = $1`,
          [eventId],
        );
        published = rows[0]!.published_at !== null;
      }
      expect(published).toBe(true);
    } finally {
      await on.close();
    }
    expect(publisher.isRunning()).toBe(false);
  });
});
