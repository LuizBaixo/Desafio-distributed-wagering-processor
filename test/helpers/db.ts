import { MikroORM } from "@mikro-orm/postgresql";
import { Client, Pool } from "pg";
import { buildMikroOrmConfig } from "../../mikro-orm.config";
import { TEST_ADMIN_URL, TEST_APP_DATABASE_URL, TEST_DATABASE_URL, TEST_DB_NAME } from "./env";

let owner: Pool | undefined;
let app: Pool | undefined;

/** Pool do papel `wagering_owner` (dono do schema; roda migrations e limpa tabelas). */
export function ownerPool(): Pool {
  owner ??= new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
  return owner;
}

/** Pool do papel `wagering_app` (o mesmo do runtime; sem DELETE nem UPDATE no ledger). */
export function appPool(): Pool {
  app ??= new Pool({ connectionString: TEST_APP_DATABASE_URL, max: 5 });
  return app;
}

async function withMigrator<T>(work: (orm: MikroORM) => Promise<T>): Promise<T> {
  const orm = await MikroORM.init(buildMikroOrmConfig(TEST_DATABASE_URL));
  try {
    return await work(orm);
  } finally {
    await orm.close(true);
  }
}

let ensured: Promise<void> | undefined;

/**
 * Garante o banco de teste do agente (TEST_DB_NAME). Se não existir, cria com dono
 * `wagering_owner` e reproduz o que infra/postgres/init-roles.sql faz no banco padrão:
 * os default privileges valem por banco, então precisam ser repetidos no banco novo.
 * Idempotente e memoizado por processo.
 */
export function ensureTestDatabase(): Promise<void> {
  ensured ??= createTestDatabaseIfMissing();
  return ensured;
}

async function createTestDatabaseIfMissing(): Promise<void> {
  const admin = new Client({ connectionString: TEST_ADMIN_URL("postgres") });
  await admin.connect();
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [TEST_DB_NAME]);
    if (exists.rowCount === 0) {
      try {
        // O nome já foi validado em env.ts (só [a-z0-9_]), então a interpolação é segura.
        await admin.query(`CREATE DATABASE ${TEST_DB_NAME} OWNER wagering_owner`);
      } catch (e) {
        if ((e as { code?: string }).code !== "42P04") throw e; // outro processo criou primeiro
      }
    }
    await admin.query(`GRANT CONNECT ON DATABASE ${TEST_DB_NAME} TO wagering_app`);
  } finally {
    await admin.end();
  }

  const inDb = new Client({ connectionString: TEST_ADMIN_URL(TEST_DB_NAME) });
  await inDb.connect();
  try {
    await inDb.query("ALTER SCHEMA public OWNER TO wagering_owner");
    await inDb.query("GRANT USAGE ON SCHEMA public TO wagering_app");
    await inDb.query(
      "ALTER DEFAULT PRIVILEGES FOR ROLE wagering_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO wagering_app",
    );
    await inDb.query(
      "ALTER DEFAULT PRIVILEGES FOR ROLE wagering_owner IN SCHEMA public GRANT USAGE ON SEQUENCES TO wagering_app",
    );
  } finally {
    await inDb.end();
  }
}

export async function migrateUp(): Promise<void> {
  await ensureTestDatabase();
  await withMigrator((orm) => orm.getMigrator().up());
}

/** Reverte todas as migrations (volta ao banco vazio). */
export async function migrateDown(): Promise<void> {
  await withMigrator((orm) => orm.getMigrator().down({ to: 0 }));
}

const TABLES = [
  "outbox_messages",
  "inbox_messages",
  "wallet_ledger_entries",
  "wager_transactions",
  "wallets",
];

/** `TRUNCATE ... RESTART IDENTITY CASCADE` como owner (o trigger do ledger só bloqueia UPDATE/DELETE). */
export async function resetDb(): Promise<void> {
  await ownerPool().query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

/** ORM conectado como `wagering_app` (papel do runtime), para exercitar a UnitOfWork de verdade. */
export async function createAppOrm(): Promise<MikroORM> {
  return MikroORM.init(buildMikroOrmConfig(TEST_APP_DATABASE_URL));
}

export async function closePools(): Promise<void> {
  await owner?.end();
  await app?.end();
  owner = undefined;
  app = undefined;
}

/** Reverte só a última migration aplicada. */
export async function migrateDownLast(): Promise<void> {
  await withMigrator((orm) => orm.getMigrator().down());
}
