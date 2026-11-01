import { MikroORM } from "@mikro-orm/postgresql";
import { Pool } from "pg";
import { buildMikroOrmConfig } from "../../mikro-orm.config";
import { TEST_APP_DATABASE_URL, TEST_DATABASE_URL } from "./env";

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

export async function migrateUp(): Promise<void> {
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
