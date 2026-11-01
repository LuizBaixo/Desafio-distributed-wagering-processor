import { Migration } from "@mikro-orm/migrations";

/**
 * Consistência do ledger com a wallet e a transação (ARCHITECTURE §6).
 *
 * - O lançamento só pode usar a moeda da própria wallet: FK composta (wallet_id, currency) -> wallets (id, currency).
 * - O lançamento só pode apontar para uma transação da mesma wallet: FK composta (transaction_id, wallet_id)
 *   -> wager_transactions (id, wallet_id).
 *
 * As FKs compostas exigem UNIQUE nas colunas referenciadas. Em base com dados que já violam as regras, a
 * validação prévia falha com uma mensagem que diz o que corrigir, em vez de deixar o `ADD CONSTRAINT`
 * estourar com um erro de FK genérico no meio da migration.
 */
export class Migration20261101000001_ledger_consistency extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      DO $check$
      DECLARE
        n bigint;
      BEGIN
        SELECT count(*) INTO n
          FROM wallet_ledger_entries l
          JOIN wallets w ON w.id = l.wallet_id
         WHERE w.currency <> l.currency;
        IF n > 0 THEN
          RAISE EXCEPTION 'ledger_consistency: % ledger entries have a currency different from their wallet; fix or remove them before migrating', n;
        END IF;

        SELECT count(*) INTO n
          FROM wallet_ledger_entries l
          JOIN wager_transactions t ON t.id = l.transaction_id
         WHERE t.wallet_id <> l.wallet_id;
        IF n > 0 THEN
          RAISE EXCEPTION 'ledger_consistency: % ledger entries point at a transaction of another wallet; fix or remove them before migrating', n;
        END IF;
      END
      $check$
    `);
    this.addSql(`ALTER TABLE wallets ADD CONSTRAINT wallets_id_currency_uq UNIQUE (id, currency)`);
    this.addSql(`ALTER TABLE wager_transactions ADD CONSTRAINT wager_tx_id_wallet_uq UNIQUE (id, wallet_id)`);
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
        ADD CONSTRAINT ledger_wallet_currency_fk
        FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency)
    `);
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
        ADD CONSTRAINT ledger_tx_wallet_fk
        FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id)
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS ledger_tx_wallet_fk`);
    this.addSql(`ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS ledger_wallet_currency_fk`);
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS wager_tx_id_wallet_uq`);
    this.addSql(`ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_id_currency_uq`);
  }
}
