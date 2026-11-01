import { MikroORM } from "@mikro-orm/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { buildMikroOrmConfig } from "../../mikro-orm.config";
import { spawnApp, type AppProcess } from "../helpers/app-process";
import { buildWagerCommand, createWalletDirect } from "../helpers/factories";
import { WAGER_DLQ, WAGER_QUEUE, purgeAll, queueDepth, sendWager, waitFor } from "../helpers/sqs";
import { TEST_DOCKER_HOST } from "../helpers/env";

/**
 * Queda real do banco. Usa um Postgres próprio e descartável (porta 55432, ou `TEST_OUTAGE_PG_PORT`; nome do container em `TEST_OUTAGE_CONTAINER`), nunca o container
 * compartilhado de teste: `docker stop` aqui não afeta nenhuma outra suíte.
 * Sem `--rm`, para o `docker start` funcionar; o container é removido no afterAll.
 */
const CONTAINER = process.env.TEST_OUTAGE_CONTAINER ?? "wagering-outage-pg";
const PG_PORT = Number(process.env.TEST_OUTAGE_PG_PORT ?? 55432);
const APP_PORT = Number(process.env.TEST_PORT_BASE ?? 4101) + 40;
const OWNER_PASSWORD = "owner";
const APP_PASSWORD = "app";
const ADMIN_URL = `postgres://postgres:postgres@${TEST_DOCKER_HOST}:${PG_PORT}/wagering`;
const OWNER_URL = `postgres://wagering_owner:${OWNER_PASSWORD}@${TEST_DOCKER_HOST}:${PG_PORT}/wagering`;
const APP_URL = `postgres://wagering_app:${APP_PASSWORD}@${TEST_DOCKER_HOST}:${PG_PORT}/wagering`;

function docker(...args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: `${r.stdout.toString()}${r.stderr.toString()}`.trim() };
}

async function waitPgReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const c = new Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 2_000 });
    try {
      await c.connect();
      await c.query("SELECT 1");
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("outage Postgres not ready");
      await Bun.sleep(300);
    } finally {
      await c.end().catch(() => undefined);
    }
  }
}

let app: AppProcess;
let owner: Pool;

beforeAll(async () => {
  docker("rm", "-f", CONTAINER);
  const run = docker(
    "run", "-d", "--name", CONTAINER, "-p", `${PG_PORT}:5432`,
    "-e", "POSTGRES_USER=postgres", "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=wagering",
    "-e", `WAGERING_OWNER_PASSWORD=${OWNER_PASSWORD}`, "-e", `WAGERING_APP_PASSWORD=${APP_PASSWORD}`,
    "postgres:17.6-alpine",
  );
  if (!run.ok) throw new Error(`docker run failed: ${run.out}`);

  await waitPgReady();
  // A imagem reinicia uma vez depois do initdb; espera estabilizar antes de usar.
  await Bun.sleep(1_500);
  await waitPgReady();

  // init-roles.sql usa meta-comandos do psql (\getenv), então roda pelo psql dentro do container, como no compose.
  const init = Bun.spawnSync(
    [
      "docker", "exec", "-i",
      "-e", `WAGERING_OWNER_PASSWORD=${OWNER_PASSWORD}`,
      "-e", `WAGERING_APP_PASSWORD=${APP_PASSWORD}`,
      CONTAINER, "psql", "-U", "postgres", "-d", "wagering", "-v", "ON_ERROR_STOP=1", "-f", "-",
    ],
    { stdin: readFileSync(join(import.meta.dir, "..", "..", "infra", "postgres", "init-roles.sql")), stdout: "pipe", stderr: "pipe" },
  );
  if (init.exitCode !== 0) throw new Error(`init-roles.sql failed: ${init.stderr.toString()}`);

  const orm = await MikroORM.init(buildMikroOrmConfig(OWNER_URL));
  try {
    await orm.getMigrator().up();
  } finally {
    await orm.close(true);
  }

  owner = new Pool({ connectionString: OWNER_URL, max: 2 });
  owner.on("error", () => undefined); // conexões ociosas morrem junto com o container
  await purgeAll();
  app = await spawnApp({
    port: APP_PORT,
    roles: "api,consumer",
    env: { DATABASE_URL: APP_URL, NODE_ENV: "test", CONSUMER_WAIT_SECONDS: "1" },
  });
}, 180_000);

afterAll(async () => {
  await app?.kill("SIGKILL").catch(() => undefined);
  await owner?.end().catch(() => undefined);
  await purgeAll().catch(() => undefined);
  docker("rm", "-f", CONTAINER);
}, 60_000);

async function counterValue(name: string, labels: string): Promise<number> {
  const text = await (await fetch(`${app.baseUrl}/metrics`)).text();
  const line = text.split("\n").find((l) => l.startsWith(`${name}{${labels}}`));
  return Number(line?.split(" ")[1] ?? "0");
}

async function scalar(sql: string, params: unknown[] = []): Promise<string> {
  return (await owner.query<{ v: string }>(sql, params)).rows[0]!.v;
}

function post(cmd: ReturnType<typeof buildWagerCommand>): Promise<Response> {
  const { idempotencyKey, ...body } = cmd;
  return fetch(`${app.baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

describe("database outage", () => {
  test("503 with Retry-After over HTTP, SQS retries without DLQ before 5 receipts, converges without double debit", async () => {
    const w = await createWalletDirect("1000.00", { pool: owner });
    const httpCmd = buildWagerCommand({ walletId: w.walletId, playerId: w.playerId, money: { amount: "5.00", currency: "BRL" } });
    const sqsCmd = buildWagerCommand({ walletId: w.walletId, playerId: w.playerId, money: { amount: "10.00", currency: "BRL" } });

    expect((await post(buildWagerCommand({ walletId: w.walletId, playerId: w.playerId, money: { amount: "1.00", currency: "BRL" } }))).status).toBe(200);

    expect(docker("stop", CONTAINER).ok).toBe(true);

    const down = await post(httpCmd).catch((e: unknown) => {
      throw new Error(`request failed: ${String(e)}; app stderr:
${app.stderr()}`);
    });
    expect(down.status).toBe(503);
    expect(down.headers.get("retry-after")).toBe("1");
    expect(((await down.json()) as { error: { code: string } }).error.code).toBe("INFRA_UNAVAILABLE");

    await sendWager(sqsCmd);
    // Backoff 2^receiveCount: recebimentos em ~0s, ~2s, ~6s. Espera pelo menos 2 retries.
    const retriesBefore = await counterValue("retries_total", 'component="consumer"');
    await waitFor(async () => (await counterValue("retries_total", 'component="consumer"')) >= retriesBefore + 2, {
      timeoutMs: 20_000,
      what: "consumer retries while DB is down",
    });
    expect(await queueDepth(WAGER_DLQ)).toBe(0);
    expect(await queueDepth(WAGER_QUEUE)).toBe(1);

    expect(docker("start", CONTAINER).ok).toBe(true);
    await waitPgReady();

    // O quinto recebimento só chega depois de ~30s de backoff acumulado: o banco volta antes.
    await waitFor(
      async () =>
        (await owner.query(`SELECT 1 FROM wager_transactions WHERE external_transaction_id = $1 AND status = 'PROCESSED'`, [sqsCmd.externalTransactionId])).rowCount === 1,
      { timeoutMs: 45_000, what: "SQS message processed after recovery" },
    );
    expect((await post(httpCmd)).status).toBe(200);
    expect((await post(httpCmd)).status).toBe(200); // replay

    expect(await scalar(`SELECT count(*)::text AS v FROM wager_transactions WHERE external_transaction_id = ANY($1)`, [[httpCmd.externalTransactionId, sqsCmd.externalTransactionId]])).toBe("2");
    expect(await scalar(`SELECT count(*)::text AS v FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [w.walletId])).toBe("3");
    expect(await scalar(`SELECT balance::text AS v FROM wallets WHERE id = $1`, [w.walletId])).toBe("984.00");

    await waitFor(async () => (await queueDepth(WAGER_QUEUE)) === 0, { timeoutMs: 15_000, what: "main queue drained" });
    expect(await queueDepth(WAGER_DLQ)).toBe(0);
  }, 180_000);
});
