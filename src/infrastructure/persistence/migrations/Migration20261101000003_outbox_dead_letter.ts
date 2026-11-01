import { Migration } from "@mikro-orm/migrations";

/**
 * Dead letter da outbox (ARCHITECTURE §13).
 *
 * - `dead_at` e `last_error`: a mensagem com falha permanente, ou com tentativas esgotadas, fica na tabela
 *   para inspeção e sai do claim e do lag.
 * - O índice parcial de claim passa a excluir as mortas.
 */
export class Migration20261101000003_outbox_dead_letter extends Migration {
  override async up(): Promise<void> {
    this.addSql(`ALTER TABLE outbox_messages ADD COLUMN dead_at timestamptz, ADD COLUMN last_error text`);
    this.addSql(`DROP INDEX IF EXISTS outbox_due`);
    this.addSql(`
      CREATE INDEX outbox_due
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL AND dead_at IS NULL
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS outbox_due`);
    this.addSql(`
      CREATE INDEX outbox_due
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL
    `);
    this.addSql(`ALTER TABLE outbox_messages DROP COLUMN IF EXISTS last_error, DROP COLUMN IF EXISTS dead_at`);
  }
}
