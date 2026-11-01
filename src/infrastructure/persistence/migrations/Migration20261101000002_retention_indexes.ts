import { Migration } from "@mikro-orm/migrations";

/**
 * Retenção de outbox e inbox (ARCHITECTURE §13).
 *
 * - Índices que sustentam o `DELETE` em lotes do job de retenção.
 * - `DELETE` só em `outbox_messages` e `inbox_messages`. O ledger, `wager_transactions` e `wallets`
 *   continuam sem `DELETE` para `wagering_app`.
 */
export class Migration20261101000002_retention_indexes extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE INDEX outbox_published_retention
        ON outbox_messages (published_at)
        WHERE published_at IS NOT NULL
    `);
    this.addSql(`CREATE INDEX inbox_received_retention ON inbox_messages (received_at)`);
    this.addSql(`GRANT DELETE ON outbox_messages, inbox_messages TO wagering_app`);
  }

  override async down(): Promise<void> {
    this.addSql(`REVOKE DELETE ON outbox_messages, inbox_messages FROM wagering_app`);
    this.addSql(`DROP INDEX IF EXISTS inbox_received_retention`);
    this.addSql(`DROP INDEX IF EXISTS outbox_published_retention`);
  }
}
