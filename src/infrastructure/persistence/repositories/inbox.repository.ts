import type { InboxRepository } from "../../../application/ports/repositories";
import type { InboxMessage } from "../../../domain/messaging/inbox-message";
import type { Db } from "../sql";

export class PgInboxRepository implements InboxRepository {
  constructor(private readonly db: Db) {}

  async tryReceive(m: InboxMessage): Promise<"new" | "duplicate"> {
    const inserted = await this.db.run(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING`,
      [m.consumerName, m.messageId, m.payloadHash, m.receivedAt, m.processedAt ?? null],
    );
    return inserted === 1 ? "new" : "duplicate";
  }
}
