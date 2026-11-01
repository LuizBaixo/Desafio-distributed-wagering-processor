import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { listDlq, redriveDlq, type DlqDeps } from "../../scripts/dlq";
import { assertLedgerConsistent } from "../helpers/assert-ledger-consistent";
import { closePools, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { buildWagerCommand, createWalletDirect, type DirectWallet } from "../helpers/factories";
import { startTestApp, type TestApp } from "../helpers/http";
import {
  WAGER_DLQ,
  WAGER_QUEUE,
  buildEnvelope,
  purgeAll,
  queueDepth,
  queueUrl,
  sendRaw,
  sqsClient,
  waitFor,
} from "../helpers/sqs";

const deps: DlqDeps = { sqs: sqsClient, queues: { main: WAGER_QUEUE, dlq: WAGER_DLQ } };
const FAST = { APP_ROLES: "consumer", CONSUMER_WAIT_SECONDS: "1", CONSUMER_MAX_BACKOFF_SECONDS: "1" };

let apps: TestApp[] = [];
let wallet: DirectWallet;

beforeAll(async () => {
  await migrateUp();
});
beforeEach(async () => {
  await resetDb();
  await purgeAll();
  wallet = await createWalletDirect("1000.00");
});
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close().catch(() => undefined)));
  apps = [];
  await assertLedgerConsistent();
});
afterAll(async () => {
  await closePools();
});

/** Copia um corpo para a DLQ como se o consumidor tivesse desistido dele (com o atributo `reason`). */
async function putInDlq(body: string, reason: string, groupId: string = wallet.walletId): Promise<void> {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: await queueUrl(WAGER_DLQ),
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: crypto.randomUUID(),
      MessageAttributes: { reason: { DataType: "String", StringValue: reason } },
    }),
  );
}

const bet = (amount = "25.00") =>
  buildWagerCommand({ walletId: wallet.walletId, playerId: wallet.playerId, money: { amount, currency: "BRL" } });

async function scalar(sql: string, params: unknown[] = []): Promise<string> {
  const r = await ownerPool().query<{ v: string }>(sql, params);
  return r.rows[0]!.v;
}

describe("ferramenta de redrive da DLQ", () => {
  test("mensagem já processada, copiada para a DLQ e redriveada: o débito continua único e a DLQ fica vazia", async () => {
    apps.push(await startTestApp(FAST));
    const cmd = bet();
    const messageId = crypto.randomUUID();
    const body = buildEnvelope(cmd, messageId);

    await sendRaw(body, wallet.walletId, messageId);
    await waitFor(async () => (await queueDepth(WAGER_QUEUE)) === 0, { what: "first delivery consumed" });
    expect(await scalar(`SELECT count(*)::text AS v FROM wager_transactions WHERE external_transaction_id = $1`, [cmd.externalTransactionId])).toBe("1");

    await putInDlq(body, "INVALID_PAYLOAD");
    const result = await redriveDlq(deps, { max: 100, dryRun: false });
    expect(result.moved).toBe(1);

    await waitFor(async () => (await queueDepth(WAGER_QUEUE)) === 0, { what: "redriven message consumed" });
    expect(await queueDepth(WAGER_DLQ)).toBe(0);
    expect(await scalar(`SELECT count(*)::text AS v FROM wallet_ledger_entries WHERE direction = 'DEBIT' AND wallet_id = $1`, [wallet.walletId])).toBe("1");
    expect(await scalar(`SELECT balance::text AS v FROM wallets WHERE id = $1`, [wallet.walletId])).toBe("975.00");
  });

  test("--dry-run não move nada", async () => {
    await putInDlq(buildEnvelope(bet(), crypto.randomUUID()), "INVALID_PAYLOAD");

    const result = await redriveDlq(deps, { max: 100, dryRun: true });
    expect(result.moved).toBe(0);
    expect(result.matched).toBe(1);
    expect(await queueDepth(WAGER_DLQ)).toBe(1);
    expect(await queueDepth(WAGER_QUEUE)).toBe(0);
  });

  test("o filtro --reason move só as mensagens com aquele motivo", async () => {
    const other = await createWalletDirect("10.00");
    await putInDlq(buildEnvelope(bet(), crypto.randomUUID()), "INVALID_PAYLOAD", wallet.walletId);
    await putInDlq(buildEnvelope(bet(), crypto.randomUUID()), "INFRA_PERMANENT", other.walletId);

    const result = await redriveDlq(deps, { reason: "INVALID_PAYLOAD", max: 100, dryRun: false });
    expect(result.moved).toBe(1);
    expect(await queueDepth(WAGER_QUEUE)).toBe(1);
    expect(await queueDepth(WAGER_DLQ)).toBe(1);
  });

  test("--max limita quantas mensagens são movidas", async () => {
    for (let i = 0; i < 3; i++) await putInDlq(buildEnvelope(bet(), crypto.randomUUID()), "INVALID_PAYLOAD", `g-${i}`);

    const result = await redriveDlq(deps, { max: 2, dryRun: false });
    expect(result.moved).toBe(2);
    expect(await queueDepth(WAGER_QUEUE)).toBe(2);
    expect(await queueDepth(WAGER_DLQ)).toBe(1);
  });

  test("list mostra motivo e prévia sem o campo money, e não remove nada da DLQ", async () => {
    await putInDlq(buildEnvelope(bet("123.45"), crypto.randomUUID()), "INVALID_PAYLOAD");
    await putInDlq("not json", "INFRA_PERMANENT", "unparseable");

    const items = await listDlq(deps, { limit: 10 });
    expect(items.map((i) => i.reason).sort()).toEqual(["INFRA_PERMANENT", "INVALID_PAYLOAD"]);
    for (const item of items) {
      expect(item.preview.length).toBeLessThanOrEqual(120);
      expect(item.preview).not.toContain("123.45");
      expect(item.preview).not.toContain('"money"');
    }
    expect(await queueDepth(WAGER_DLQ)).toBe(2);
  });
});
