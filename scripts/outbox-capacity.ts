// Mede a capacidade do publisher da outbox sem SQS (QueuePort no-op): só o custo de claim e markPublishedMany
// no PostgreSQL de teste, com 1 e com 3 publicadores concorrentes sobre 50 mil eventos.
// Uso: TEST_DB_NAME=wagering_bench bun run bench:outbox (requer `bun run infra:test:up`).
import { OutboxPublisher } from "../src/interfaces/workers/outbox-publisher";
import { MikroUnitOfWork } from "../src/infrastructure/persistence/mikro-unit-of-work";
import { createAppOrm, migrateUp, ownerPool } from "../test/helpers/db";
const N = 50_000;
await migrateUp();
const pool = ownerPool();
await pool.query("TRUNCATE outbox_messages");
await pool.query(`INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
  SELECT gen_random_uuid(), 'w'||(g%200), 'WalletBalanceChanged', jsonb_build_object('pad', repeat('x',400)), now() - interval '1 min' + (g||' us')::interval, 0, now() - interval '1 min'
  FROM generate_series(1, ${N}) g`);
await pool.query("ANALYZE outbox_messages");
const noopQueue: any = { sendBatch: async (_q: string, e: Array<{ id: string }>) => ({ ok: e.map((x) => x.id), failed: [] }) };
const clock = { now: () => new Date() };
const metrics: any = new Proxy({}, { get: () => () => {} });
const logger: any = { info() {}, warn() {}, error() {} };
async function run(publishers: number) {
  await pool.query("UPDATE outbox_messages SET published_at = NULL, locked_until = NULL");
  const orms = await Promise.all(Array.from({ length: publishers }, () => createAppOrm()));
  const pubs = orms.map((o) => new OutboxPublisher(new MikroUnitOfWork(o.em), noopQueue, clock, metrics, logger, { queueName: "x", pollMs: 0, enabled: false, batchSize: 100, sendBatchSize: 10 }));
  const t = performance.now();
  let total = 0;
  await Promise.all(pubs.map(async (p) => { for (;;) { const n = await p.tick(); total += n; if (n === 0) break; } }));
  const s = (performance.now() - t) / 1000;
  const left = (await pool.query("SELECT count(*)::int c FROM outbox_messages WHERE published_at IS NULL")).rows[0].c;
  console.log(`${publishers} publisher(s): ${total} publicados em ${s.toFixed(1)} s -> ${(total / s).toFixed(0)} ev/s; pendentes=${left}`);
  await Promise.all(orms.map((o) => o.close()));
}
await run(1);
await run(3);
await pool.query("TRUNCATE outbox_messages");
await pool.end();
process.exit(0);
