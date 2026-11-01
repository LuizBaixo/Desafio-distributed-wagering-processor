import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GetQueueAttributesCommand, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { closePools, migrateUp, ownerPool, resetDb } from "../helpers/db";
import { TEST_DB_NAME } from "../helpers/env";
import { buildWagerCommand, createWalletDirect } from "../helpers/factories";
import { startTestApp, type TestApp } from "../helpers/http";
import { WAGER_QUEUE, buildEnvelope, purgeAll, queueUrl, sqsClient } from "../helpers/sqs";
import { SendMessageCommand } from "@aws-sdk/client-sqs";

/** Fila padrão da infra de teste, a que outra execução (outro TEST_DB_NAME) também usaria. */
const SHARED_QUEUE = "wager-transactions.fifo";

let app: TestApp | undefined;

beforeAll(async () => {
  await migrateUp();
});
beforeEach(async () => {
  await resetDb();
  await purgeAll();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});
afterAll(async () => {
  await closePools();
});

async function depth(name: string): Promise<number> {
  const res = await sqsClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: await queueUrl(name),
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return Object.values(res.Attributes ?? {}).reduce((sum, v) => sum + Number(v), 0);
}

/**
 * Duas execuções de teste ao mesmo tempo (bancos diferentes) não podem consumir as mensagens uma da outra.
 * Só faz sentido fora do banco padrão: no padrão, a fila compartilhada é a própria fila da execução.
 */
describe.skipIf(TEST_DB_NAME === "wagering")("isolamento de filas entre execuções de teste", () => {
  test("o consumer de uma execução não consome mensagem enviada à fila compartilhada de outra", async () => {
    const wallet = await createWalletDirect("100.00");
    const cmd = buildWagerCommand({ walletId: wallet.walletId, playerId: wallet.playerId });

    // Mensagem de outra execução, na fila de nome padrão.
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: await queueUrl(SHARED_QUEUE),
        MessageBody: buildEnvelope(cmd, "foreign-message"),
        MessageGroupId: cmd.walletId,
        MessageDeduplicationId: crypto.randomUUID(),
      }),
    );

    app = await startTestApp({ APP_ROLES: "consumer", CONSUMER_WAIT_SECONDS: "1" });
    await Bun.sleep(3000);

    const inbox = await ownerPool().query(`SELECT 1 FROM inbox_messages`);
    expect(inbox.rowCount).toBe(0);
    expect(await depth(SHARED_QUEUE)).toBe(1);
    expect(WAGER_QUEUE).not.toBe(SHARED_QUEUE);

    // Limpeza da fila compartilhada: esta mensagem não pertence a nenhuma outra execução.
    const url = await queueUrl(SHARED_QUEUE);
    const res = await sqsClient.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    for (const m of res.Messages ?? []) {
      await sqsClient.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle! }));
    }
  });
});

describe("purgeAll", () => {
  test("espera mensagem em voo de uma execução anterior reaparecer e a remove: as filas ficam com profundidade 0", async () => {
    const url = await queueUrl(WAGER_QUEUE);
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: url,
        MessageBody: "{}",
        MessageGroupId: "stale-group",
        MessageDeduplicationId: crypto.randomUUID(),
      }),
    );
    // Como um processo morto deixaria: recebida, não apagada, invisível por 4 s.
    const res = await sqsClient.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 1, VisibilityTimeout: 4 }));
    expect(res.Messages).toHaveLength(1);
    expect(await depth(WAGER_QUEUE)).toBe(1);

    await purgeAll();

    expect(await depth(WAGER_QUEUE)).toBe(0);
  });
});
