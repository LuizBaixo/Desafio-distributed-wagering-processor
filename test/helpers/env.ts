/**
 * Banco de teste por agente: `TEST_DB_NAME=wagering_forja bun run test:integration`.
 * O padrão `wagering` é o banco criado pelo docker-compose.test.yml. Qualquer outro nome é
 * criado sob demanda por `ensureTestDatabase()` (ver helpers/db.ts).
 */
export const TEST_DB_NAME = process.env.TEST_DB_NAME ?? "wagering";

if (!/^[a-z][a-z0-9_]{0,62}$/.test(TEST_DB_NAME)) {
  throw new Error(`TEST_DB_NAME inválido: ${TEST_DB_NAME} (use minúsculas, dígitos e _)`);
}

/** Host:porta do Postgres de teste. Em CI ou dentro de um container, aponte para o host certo (ex.: host.docker.internal:5433). */
export const TEST_DB_HOST = process.env.TEST_DB_HOST ?? "localhost:5433";
export const TEST_DATABASE_URL = `postgres://wagering_owner:owner@${TEST_DB_HOST}/${TEST_DB_NAME}`;
export const TEST_APP_DATABASE_URL = `postgres://wagering_app:app@${TEST_DB_HOST}/${TEST_DB_NAME}`;
/** Superusuário do container, usado só para criar bancos de teste. */
export const TEST_ADMIN_URL = (database: string) => `postgres://postgres:postgres@${TEST_DB_HOST}/${database}`;
export const TEST_SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? "http://localhost:4567";
/** Host onde ficam as portas publicadas por containers que os próprios testes sobem (db-outage). */
export const TEST_DOCKER_HOST = process.env.TEST_DOCKER_HOST ?? "localhost";

/**
 * Filas por execução: com `TEST_DB_NAME` diferente do padrão, cada execução usa as próprias filas
 * (`wager-transactions-<db>.fifo` etc.). Filas de nome fixo seriam compartilhadas, e o consumidor de uma
 * execução consumiria as mensagens de outra (o banco dela não tem a wallet). No banco padrão, valem os nomes
 * criados pelo `sqs-init`.
 */
const QUEUE_SUFFIX = TEST_DB_NAME === "wagering" ? "" : `-${TEST_DB_NAME}`;
export const TEST_WAGER_QUEUE = `wager-transactions${QUEUE_SUFFIX}.fifo`;
export const TEST_WAGER_DLQ = `wager-transactions-dlq${QUEUE_SUFFIX}.fifo`;
export const TEST_EVENTS_QUEUE = `wallet-events${QUEUE_SUFFIX}.fifo`;
/** Variáveis de ambiente que apontam a aplicação para as filas desta execução. */
export const TEST_QUEUE_ENV = {
  WAGER_QUEUE_NAME: TEST_WAGER_QUEUE,
  WAGER_DLQ_NAME: TEST_WAGER_DLQ,
  WALLET_EVENTS_QUEUE_NAME: TEST_EVENTS_QUEUE,
};
