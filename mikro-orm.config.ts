import { defineConfig, type Options } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { Migration20261031000001_initial } from "./src/infrastructure/persistence/migrations/Migration20261031000001_initial";
import { Migration20261101000001_ledger_consistency } from "./src/infrastructure/persistence/migrations/Migration20261101000001_ledger_consistency";
import { Migration20261101000002_retention_indexes } from "./src/infrastructure/persistence/migrations/Migration20261101000002_retention_indexes";
import { Migration20261101000003_outbox_dead_letter } from "./src/infrastructure/persistence/migrations/Migration20261101000003_outbox_dead_letter";

/**
 * Banco local do `docker-compose.test.yml` (papel dono do schema). Em outros ambientes,
 * defina `MIGRATION_DATABASE_URL` (ou `DATABASE_URL`) com o papel `wagering_owner`.
 */
const LOCAL_OWNER_URL = "postgres://wagering_owner:owner@localhost:5433/wagering";

export function buildMikroOrmConfig(clientUrl: string): Options {
  return defineConfig({
    clientUrl,
    // Migrations escritas à mão; o schema não é derivado de entidades.
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      path: "./src/infrastructure/persistence/migrations",
      pathTs: "./src/infrastructure/persistence/migrations",
      // Lista explícita: funciona igual sob Bun (sem varredura de arquivos) e em imagens compiladas.
      migrationsList: [
        { name: "Migration20261031000001_initial", class: Migration20261031000001_initial },
        { name: "Migration20261101000001_ledger_consistency", class: Migration20261101000001_ledger_consistency },
        { name: "Migration20261101000002_retention_indexes", class: Migration20261101000002_retention_indexes },
        { name: "Migration20261101000003_outbox_dead_letter", class: Migration20261101000003_outbox_dead_letter },
      ],
      transactional: true,
      disableForeignKeys: false,
      allOrNothing: true,
      snapshot: false,
    },
  });
}

export default buildMikroOrmConfig(
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? LOCAL_OWNER_URL,
);
