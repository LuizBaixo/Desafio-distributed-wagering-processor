import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import type { WagerCommand } from "../../src/application/wagering/wager-command";
import { TEST_SQS_ENDPOINT } from "./env";

export const WAGER_QUEUE = "wager-transactions.fifo";
export const WAGER_DLQ = "wager-transactions-dlq.fifo";
export const EVENTS_QUEUE = "wallet-events.fifo";

export const sqsClient = new SQSClient({
  endpoint: TEST_SQS_ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

const urls = new Map<string, string>();
export async function queueUrl(name: string): Promise<string> {
  let url = urls.get(name);
  if (!url) {
    url = (await sqsClient.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
    urls.set(name, url);
  }
  return url;
}

/** Envelope do README §10. A `idempotencyKey` do comando vai dentro de `data`. */
export function buildEnvelope(cmd: WagerCommand, messageId: string): string {
  return JSON.stringify({
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: { ...cmd },
  });
}

/**
 * Envia um comando para a fila principal. `groupId = walletId`; `dedupId = messageId` por padrão.
 * Passe `dedupId` diferente para reenviar o mesmo `messageId` escapando da deduplicação do FIFO.
 */
export async function sendWager(
  cmd: WagerCommand,
  messageId: string = crypto.randomUUID(),
  dedupId: string = messageId,
): Promise<string> {
  await sendRaw(buildEnvelope(cmd, messageId), cmd.walletId, dedupId);
  return messageId;
}

/** Envia um corpo arbitrário (inclusive JSON inválido). */
export async function sendRaw(body: string, groupId: string, dedupId: string = crypto.randomUUID()): Promise<void> {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: await queueUrl(WAGER_QUEUE),
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: dedupId,
    }),
  );
}

/**
 * Esvazia as filas de teste lendo e apagando o que está visível. Não usa PurgeQueue: o SQS (e o
 * MiniStack) podem descartar mensagens enviadas até 60 s depois de um purge, o que apagaria
 * mensagens de testes seguintes. Mensagens em voo de um consumidor já parado reaparecem pelo
 * visibility timeout; por isso cada teste usa uma wallet própria.
 */
export async function purgeAll(): Promise<void> {
  for (const name of [WAGER_QUEUE, WAGER_DLQ, EVENTS_QUEUE]) {
    await drain(name);
  }
}

export interface ReceivedMessage {
  body: string;
  attributes: Record<string, string>;
  receiveCount: number;
}

/**
 * Lê (e remove) tudo que está visível na fila. Para a DLQ é o jeito de inspecionar o que chegou,
 * inclusive os atributos de mensagem.
 */
export async function receiveAll(queue: string, waitSeconds = 1): Promise<ReceivedMessage[]> {
  const QueueUrl = await queueUrl(queue);
  const out: ReceivedMessage[] = [];
  for (;;) {
    const res = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: 5,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    const batch = res.Messages ?? [];
    if (batch.length === 0) return out;
    for (const m of batch) {
      out.push({
        body: m.Body ?? "",
        attributes: Object.fromEntries(
          Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue ?? ""]),
        ),
        receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 0),
      });
      await sqsClient.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle! }));
    }
  }
}

async function drain(queue: string): Promise<void> {
  await receiveAll(queue, 0);
}

/** Mensagens visíveis + em voo + atrasadas, para afirmar que a fila principal ficou vazia. */
export async function queueDepth(queue: string): Promise<number> {
  const res = await sqsClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: await queueUrl(queue),
      AttributeNames: [
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
        "ApproximateNumberOfMessagesDelayed",
      ],
    }),
  );
  return Object.values(res.Attributes ?? {}).reduce((sum, v) => sum + Number(v), 0);
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<void> {
  const { timeoutMs = 20_000, intervalMs = 150, what = "condition" } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`timeout (${timeoutMs}ms) waiting for ${what}`);
}
