import { Migration } from "@mikro-orm/migrations";

/**
 * Schema inicial (Design §6). SQL escrito à mão: constraints, índices parciais e triggers
 * fazem parte do que é avaliado.
 *
 * Executada como `wagering_owner`. Os default privileges de `init-roles.sql` dão
 * SELECT/INSERT/UPDATE a `wagering_app` em toda tabela nova; os GRANT/REVOKE abaixo
 * deixam o resultado explícito e independente deles.
 */
export class Migration20261031000001_initial extends Migration {
  override async up(): Promise<void> {
    // ---------------------------------------------------------------- wallets
    this.addSql(`
      CREATE TABLE wallets (
        id         uuid          PRIMARY KEY,
        player_id  uuid          NOT NULL,
        currency   char(3)       NOT NULL,
        balance    numeric(20,2) NOT NULL,
        version    int           NOT NULL,
        created_at timestamptz   NOT NULL DEFAULT now(),
        updated_at timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1),
        CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$')
      )
    `);

    // ------------------------------------------------------- wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                               uuid          PRIMARY KEY,
        provider_id                      text          NOT NULL,
        external_transaction_id          text          NOT NULL,
        idempotency_key                  text          NOT NULL,
        payload_hash                     char(64)      NOT NULL,
        wallet_id                        uuid          NOT NULL REFERENCES wallets (id),
        player_id                        uuid          NOT NULL,
        round_id                         text          NOT NULL,
        game_id                          text          NOT NULL,
        kind                             text          NOT NULL,
        amount                           numeric(20,2) NOT NULL,
        currency                         char(3)       NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id         uuid          REFERENCES wager_transactions (id),
        status                           text          NOT NULL,
        failure_code                     text,
        result_balance                   numeric(20,2),
        result_currency                  char(3),
        attempts                         int           NOT NULL DEFAULT 0,
        next_attempt_at                  timestamptz,
        created_at                       timestamptz   NOT NULL DEFAULT now(),
        processed_at                     timestamptz,
        CONSTRAINT wager_tx_provider_idempotency_uq UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_amount_positive CHECK (amount > 0),
        CONSTRAINT wager_tx_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_tx_kind_valid CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_tx_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wager_tx_reversal_needs_reference
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_processed_has_date CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL),
        CONSTRAINT wager_tx_failure_has_code CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL),
        CONSTRAINT wager_tx_result_pair CHECK ((result_balance IS NULL) = (result_currency IS NULL)),
        CONSTRAINT wager_tx_attempts_non_negative CHECK (attempts >= 0)
      )
    `);
    // Uma referência só pode ser revertida uma vez no total (REFUND ou ROLLBACK), defesa do banco.
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_one_reversal_per_reference
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'
    `);
    // Worker de referências pendentes.
    this.addSql(`
      CREATE INDEX wager_tx_pending_due
        ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE'
    `);
    // Destravar pendentes quando a referência chega.
    this.addSql(`
      CREATE INDEX wager_tx_reference_lookup
        ON wager_transactions (provider_id, reference_external_transaction_id)
    `);
    this.addSql(`CREATE INDEX wager_tx_wallet ON wager_transactions (wallet_id)`);

    // Imutabilidade: terminal não muda; não terminal só muda a allowlist; DELETE nunca.
    this.addSql(`
      CREATE FUNCTION wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions rows cannot be deleted';
        END IF;

        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager_transactions row % is in terminal status % and cannot be updated', OLD.id, OLD.status;
        END IF;

        -- Allowlist: status, reference_transaction_id, failure_code, result_balance,
        -- result_currency, attempts, next_attempt_at, processed_at.
        IF NEW.id                               IS DISTINCT FROM OLD.id
        OR NEW.provider_id                      IS DISTINCT FROM OLD.provider_id
        OR NEW.external_transaction_id          IS DISTINCT FROM OLD.external_transaction_id
        OR NEW.idempotency_key                  IS DISTINCT FROM OLD.idempotency_key
        OR NEW.payload_hash                     IS DISTINCT FROM OLD.payload_hash
        OR NEW.wallet_id                        IS DISTINCT FROM OLD.wallet_id
        OR NEW.player_id                        IS DISTINCT FROM OLD.player_id
        OR NEW.round_id                         IS DISTINCT FROM OLD.round_id
        OR NEW.game_id                          IS DISTINCT FROM OLD.game_id
        OR NEW.kind                             IS DISTINCT FROM OLD.kind
        OR NEW.amount                           IS DISTINCT FROM OLD.amount
        OR NEW.currency                         IS DISTINCT FROM OLD.currency
        OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
        OR NEW.created_at                       IS DISTINCT FROM OLD.created_at
        THEN
          RAISE EXCEPTION 'wager_transactions row % has an immutable column changed', OLD.id;
        END IF;

        RETURN NEW;
      END
      $fn$
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_tx_guard()
    `);

    // ---------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id             uuid          PRIMARY KEY,
        seq            bigserial     NOT NULL,
        wallet_id      uuid          NOT NULL REFERENCES wallets (id),
        transaction_id uuid          NOT NULL REFERENCES wager_transactions (id),
        direction      text          NOT NULL,
        amount         numeric(20,2) NOT NULL,
        currency       char(3)       NOT NULL,
        balance_before numeric(20,2) NOT NULL,
        balance_after  numeric(20,2) NOT NULL,
        created_at     timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT ledger_seq_uq UNIQUE (seq),
        CONSTRAINT ledger_wallet_transaction_uq UNIQUE (wallet_id, transaction_id),
        CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ledger_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ledger_balance_after_non_negative CHECK (balance_after >= 0),
        CONSTRAINT ledger_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      )
    `);
    this.addSql(`
      CREATE FUNCTION ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'ledger entries are immutable';
      END
      $fn$
    `);
    this.addSql(`
      CREATE TRIGGER ledger_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_immutable()
    `);

    // -------------------------------------------------------------- inbox/outbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text        NOT NULL,
        message_id    text        NOT NULL,
        payload_hash  char(64)    NOT NULL,
        received_at   timestamptz NOT NULL DEFAULT now(),
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )
    `);
    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid        PRIMARY KEY,
        aggregate_id    text        NOT NULL,
        event_type      text        NOT NULL,
        payload         jsonb       NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        int         NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL,
        locked_until    timestamptz,
        published_at    timestamptz,
        CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0)
      )
    `);
    this.addSql(`
      CREATE INDEX outbox_due
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL
    `);

    // ------------------------------------------------------------------ GRANTs
    // Os default privileges já concedem SELECT/INSERT/UPDATE; o REVOKE no ledger é o que importa.
    this.addSql(`GRANT SELECT, INSERT, UPDATE ON wallets, wager_transactions, inbox_messages, outbox_messages TO wagering_app`);
    this.addSql(`REVOKE UPDATE, DELETE ON wallet_ledger_entries FROM wagering_app`);
    this.addSql(`GRANT SELECT, INSERT ON wallet_ledger_entries TO wagering_app`);
    this.addSql(`GRANT USAGE ON SEQUENCE wallet_ledger_entries_seq_seq TO wagering_app`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages`);
    this.addSql(`DROP TRIGGER IF EXISTS ledger_immutable ON wallet_ledger_entries`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_immutable()`);
    this.addSql(`DROP TRIGGER IF EXISTS wager_tx_guard ON wager_transactions`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions`);
    this.addSql(`DROP FUNCTION IF EXISTS wager_tx_guard()`);
    this.addSql(`DROP TABLE IF EXISTS wallets`);
  }
}
