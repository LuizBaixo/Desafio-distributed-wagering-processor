/**
 * Banco de teste por agente: `TEST_DB_NAME=wagering_forja bun run test:integration`.
 * O padrão `wagering` é o banco criado pelo docker-compose.test.yml. Qualquer outro nome é
 * criado sob demanda por `ensureTestDatabase()` (ver helpers/db.ts).
 */
export const TEST_DB_NAME = process.env.TEST_DB_NAME ?? "wagering";

if (!/^[a-z][a-z0-9_]{0,62}$/.test(TEST_DB_NAME)) {
  throw new Error(`TEST_DB_NAME inválido: ${TEST_DB_NAME} (use minúsculas, dígitos e _)`);
}

export const TEST_DB_HOST = "localhost:5433";
export const TEST_DATABASE_URL = `postgres://wagering_owner:owner@${TEST_DB_HOST}/${TEST_DB_NAME}`;
export const TEST_APP_DATABASE_URL = `postgres://wagering_app:app@${TEST_DB_HOST}/${TEST_DB_NAME}`;
/** Superusuário do container, usado só para criar bancos de teste. */
export const TEST_ADMIN_URL = (database: string) => `postgres://postgres:postgres@${TEST_DB_HOST}/${database}`;
export const TEST_SQS_ENDPOINT = "http://localhost:4567";
