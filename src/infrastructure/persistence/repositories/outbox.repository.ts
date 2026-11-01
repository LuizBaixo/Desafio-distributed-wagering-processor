import type { OutboxRepository } from "../../../application/ports/repositories";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { outboxFromRow, toDate } from "../mappers";
import type { OutboxRow } from "../schemas";
import type { Db } from "../sql";

export class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly db: Db) {}

  async enqueue(m: OutboxMessage): Promise<void> {
    await this.db.run(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       VALUES (?, ?, ?, ?::jsonb, ?, ?, ?)`,
      [
        m.id,
        m.aggregateId,
        m.eventType,
        JSON.stringify(m.payload),
        m.occurredAt,
        m.attempts,
        m.nextAttemptAt ?? m.occurredAt,
      ],
    );
  }

  async claimDue(limit: number, leaseSeconds: number, now: Date): Promise<OutboxMessage[]> {
    const rows = await this.db.rows<OutboxRow>(
      `UPDATE outbox_messages
          SET locked_until = ?::timestamptz + make_interval(secs => ?)
        WHERE id IN (
          SELECT id FROM outbox_messages
           WHERE published_at IS NULL
             AND next_attempt_at <= ?
             AND (locked_until IS NULL OR locked_until < ?)
           ORDER BY occurred_at
           FOR UPDATE SKIP LOCKED
           LIMIT ?)
       RETURNING *`,
      [now, leaseSeconds, now, now, limit],
    );
    // RETURNING não garante ordem; a ordem de ocorrência importa para o grupo FIFO.
    rows.sort((a, b) => toDate(a.occurred_at).getTime() - toDate(b.occurred_at).getTime() || a.id.localeCompare(b.id));
    return rows.map(outboxFromRow);
  }

  async markPublished(id: string, at: Date): Promise<void> {
    await this.db.run(`UPDATE outbox_messages SET published_at = ?, locked_until = NULL WHERE id = ?`, [at, id]);
  }

  async markPublishedMany(ids: string[], at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    // Um único parâmetro com literal de array do Postgres: o driver expandiria um array JS em vários placeholders.
    return this.db.run(
      `UPDATE outbox_messages SET published_at = ?, locked_until = NULL
        WHERE id = ANY(?::uuid[]) AND published_at IS NULL`,
      [at, `{${ids.join(",")}}`],
    );
  }

  async release(m: OutboxMessage): Promise<void> {
    await this.db.run(
      `UPDATE outbox_messages SET attempts = ?, next_attempt_at = ?, locked_until = NULL WHERE id = ?`,
      [m.attempts, m.nextAttemptAt ?? m.occurredAt, m.id],
    );
  }

  async oldestPendingAgeSeconds(now: Date): Promise<number> {
    const row = await this.db.one<{ age: string }>(
      `SELECT COALESCE(EXTRACT(EPOCH FROM (?::timestamptz - MIN(occurred_at))), 0)::text AS age
         FROM outbox_messages WHERE published_at IS NULL`,
      [now],
    );
    return Math.max(0, Number(row?.age ?? 0));
  }
}
