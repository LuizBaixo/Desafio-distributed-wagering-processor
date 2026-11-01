import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { PurgeMessagingTables } from "../../src/application/messaging/purge-messaging-tables";
import { loadConfig } from "../../src/config/config";
import { PgAdvisoryLock } from "../../src/infrastructure/persistence/pg-advisory-lock";
import { RetentionWorker } from "../../src/interfaces/workers/retention.worker";
import type { Logger } from "../../src/application/ports/logger";
import { appPool, closePools, migrateDownLast, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { TEST_APP_DATABASE_URL, TEST_SQS_ENDPOINT } from "../helpers/env";
import { startTestApp, type TestApp } from "../helpers/http";

const silent: Logger = { info() {}, warn() {}, error() {} };
const HOUR = 3_600_000;

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
  // Nenhum teste pode deixar o lock preso.
  const probe = new PgAdvisoryLock(TEST_APP_DATABASE_URL);
  expect(await probe.runExclusive("retention", async () => "free")).toEqual({ acquired: true, value: "free" });
});
afterAll(async () => {
  await app.close();
  await closePools();
});

function config(env: Record<string, string> = {}) {
  return loadConfig({ DATABASE_URL: TEST_APP_DATABASE_URL, SQS_ENDPOINT: TEST_SQS_ENDPOINT, ...env });
}

async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

async function seedOutbox(opts: { publishedHoursAgo?: number; occurredHoursAgo?: number }): Promise<string> {
  const id = crypto.randomUUID();
  const occurred = new Date(Date.now() - (opts.occurredHoursAgo ?? opts.publishedHoursAgo ?? 0) * HOUR);
  const published = opts.publishedHoursAgo === undefined ? null : new Date(Date.now() - opts.publishedHoursAgo * HOUR);
  await ownerPool().query(
    `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at, published_at)
     VALUES ($1, 'agg', 'WalletCreated', '{}'::jsonb, $2, $2, $3)`,
    [id, occurred, published],
  );
  return id;
}

async function seedInbox(hoursAgo: number, processed: boolean): Promise<string> {
  const messageId = crypto.randomUUID();
  const at = new Date(Date.now() - hoursAgo * HOUR);
  await ownerPool().query(
    `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
     VALUES ('c', $1, $2, $3, $4)`,
    [messageId, "a".repeat(64), at, processed ? at : null],
  );
  return messageId;
}

async function outboxIds(): Promise<string[]> {
  return (await ownerPool().query<{ id: string }>(`SELECT id FROM outbox_messages`)).rows.map((r) => r.id);
}
async function inboxIds(): Promise<string[]> {
  return (await ownerPool().query<{ message_id: string }>(`SELECT message_id FROM inbox_messages`)).rows.map(
    (r) => r.message_id,
  );
}

describe("PurgeMessagingTables", () => {
  const run = () => container.get(PurgeMessagingTables).run({ outboxRetentionHours: 168, inboxRetentionHours: 168 });

  test("published outbox older than the retention is deleted; newer stays", async () => {
    await seedOutbox({ publishedHoursAgo: 200 });
    const fresh = await seedOutbox({ publishedHoursAgo: 10 });

    const res = await run();

    expect(res.outbox).toBe(1);
    expect(await outboxIds()).toEqual([fresh]);
  });

  test("unpublished outbox is never deleted, whatever its age", async () => {
    const ancient = await seedOutbox({ occurredHoursAgo: 24 * 365 });
    const old = await seedOutbox({ occurredHoursAgo: 500 });

    const res = await run();

    expect(res.outbox).toBe(0);
    expect((await outboxIds()).sort()).toEqual([ancient, old].sort());
  });

  test("inbox newer than the retention stays; older is deleted (processed_at set or not)", async () => {
    const fresh = await seedInbox(10, true);
    const freshUnmarked = await seedInbox(100, false);
    await seedInbox(200, true);
    await seedInbox(300, false);

    const res = await run();

    expect(res.inbox).toBe(2);
    expect((await inboxIds()).sort()).toEqual([fresh, freshUnmarked].sort());
  });

  test("deletes in batches until nothing is left to purge", async () => {
    await ownerPool().query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at, published_at)
       SELECT gen_random_uuid(), 'a', 'E', '{}'::jsonb, now() - interval '300 hours', now(), now() - interval '300 hours'
         FROM generate_series(1, 25)`,
    );
    const res = await container
      .get(PurgeMessagingTables)
      .run({ outboxRetentionHours: 168, inboxRetentionHours: 168 }, 10);
    expect(res.outbox).toBe(25);
    expect(await outboxIds()).toEqual([]);
  });

  test("inbox retention below 24h is refused by the use case as well", async () => {
    await expect(
      container.get(PurgeMessagingTables).run({ outboxRetentionHours: 168, inboxRetentionHours: 1 }),
    ).rejects.toThrow(/24/);
  });
});

describe("grants and indexes", () => {
  test("wagering_app can delete from outbox_messages and inbox_messages", async () => {
    const o = await seedOutbox({ publishedHoursAgo: 1 });
    const i = await seedInbox(1, true);
    expect((await appPool().query(`DELETE FROM outbox_messages WHERE id = $1`, [o])).rowCount).toBe(1);
    expect((await appPool().query(`DELETE FROM inbox_messages WHERE message_id = $1`, [i])).rowCount).toBe(1);
  });

  test("wagering_app still has no DELETE on wallet_ledger_entries, wager_transactions and wallets (42501)", async () => {
    expect(await pgCode(appPool().query(`DELETE FROM wallet_ledger_entries`))).toBe("42501");
    expect(await pgCode(appPool().query(`DELETE FROM wager_transactions`))).toBe("42501");
    expect(await pgCode(appPool().query(`DELETE FROM wallets`))).toBe("42501");
  });

  test("the retention indexes exist", async () => {
    const { rows } = await ownerPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename IN ('outbox_messages','inbox_messages')`,
    );
    const defs = rows.map((r) => r.indexdef).join("\n");
    expect(defs).toMatch(/outbox_messages.*\(published_at\) WHERE \(published_at IS NOT NULL\)/);
    expect(defs).toMatch(/inbox_messages.*\(received_at\)/);
  });

  test("down revokes DELETE and drops the indexes; up restores them", async () => {
    await migrateDownLast(); // dead letter da outbox
    await migrateDownLast(); // retenção
    try {
      expect(await pgCode(appPool().query(`DELETE FROM outbox_messages`))).toBe("42501");
      expect(await pgCode(appPool().query(`DELETE FROM inbox_messages`))).toBe("42501");
      const { rowCount } = await ownerPool().query(
        `SELECT 1 FROM pg_indexes WHERE indexname IN ('outbox_published_retention', 'inbox_received_retention')`,
      );
      expect(rowCount).toBe(0);
    } finally {
      await migrateUp();
    }
    expect((await appPool().query(`DELETE FROM outbox_messages`)).rowCount).toBe(0);
  });
});

describe("RetentionWorker (advisory lock)", () => {
  function gated() {
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
          return { outbox: 3, inbox: 4 };
        },
      },
    };
  }
  const worker = (job: { run(...a: never[]): Promise<{ outbox: number; inbox: number }> }) =>
    new RetentionWorker(config(), silent, new PgAdvisoryLock(TEST_APP_DATABASE_URL), job as unknown as PurgeMessagingTables);

  test("two workers at once: one runs, the other is skipped; lock free afterwards", async () => {
    const first = gated();
    const a = worker(first.job);
    const b = worker({ run: async () => ({ outbox: 9, inbox: 9 }) });

    const running = a.runOnce();
    await first.hasStarted;
    expect(await b.runOnce()).toEqual({ status: "skipped" });

    first.release();
    expect(await running).toEqual({ status: "completed", outbox: 3, inbox: 4 });
    expect(await b.runOnce()).toEqual({ status: "completed", outbox: 9, inbox: 9 });
  });

  test("a job that throws releases the lock", async () => {
    const failing = worker({
      run: async () => {
        throw new Error("boom");
      },
    });
    await expect(failing.runOnce()).rejects.toThrow("boom");
    expect(await worker({ run: async () => ({ outbox: 0, inbox: 0 }) }).runOnce()).toEqual({
      status: "completed",
      outbox: 0,
      inbox: 0,
    });
  });

  test("the loop is off without the role; with the role it purges on its own and stops on shutdown", async () => {
    expect(container.get(RetentionWorker).isRunning()).toBe(false);
    await seedOutbox({ publishedHoursAgo: 500 });
    const on = await startTestApp({ APP_ROLES: "api,retention", RETENTION_INTERVAL_MS: "200" });
    const w = (on.app as INestApplication).get(RetentionWorker);
    try {
      expect(w.isRunning()).toBe(true);
      for (let i = 0; i < 60 && (await outboxIds()).length > 0; i++) await Bun.sleep(100);
      expect(await outboxIds()).toEqual([]);
    } finally {
      await on.close();
    }
    expect(w.isRunning()).toBe(false);
  });
});

describe("config", () => {
  test("defaults: outbox 168h, inbox 168h, interval 3600000 ms", () => {
    expect(config().retention).toEqual({ outboxHours: 168, inboxHours: 168, intervalMs: 3_600_000 });
    expect(config({ APP_ROLES: "retention" }).roles.has("retention")).toBe(true);
  });

  test("INBOX_RETENTION_HOURS=1 fails the config; 24 passes", () => {
    expect(() => config({ INBOX_RETENTION_HOURS: "1" })).toThrow(/INBOX_RETENTION_HOURS/);
    expect(config({ INBOX_RETENTION_HOURS: "24" }).retention.inboxHours).toBe(24);
  });
});
