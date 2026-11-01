import type { InboxRepository } from "../../../application/ports/repositories";
import type { InboxMessage } from "../../../domain/messaging/inbox-message";
import type { Db } from "../sql";

export class PgInboxRepository implements InboxRepository {
  constructor(private readonly db: Db) {}

  async tryReceive(m: InboxMessage): Promise<"new" | "duplicate" | "conflict"> {
    const inserted = await this.db.run(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING`,
      [m.consumerName, m.messageId, m.payloadHash, m.receivedAt, m.processedAt ?? null],
    );
    if (inserted === 1) return "new";
    const existing = await this.db.one<{ payload_hash: string }>(
      `SELECT payload_hash FROM inbox_messages WHERE consumer_name = ? AND message_id = ?`,
      [m.consumerName, m.messageId],
    );
    return existing !== null && existing.payload_hash !== m.payloadHash ? "conflict" : "duplicate";
  }
}
