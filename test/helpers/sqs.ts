import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import type { WagerCommand } from "../../src/application/wagering/wager-command";
import { TEST_EVENTS_QUEUE, TEST_SQS_ENDPOINT, TEST_WAGER_DLQ, TEST_WAGER_QUEUE } from "./env";

export const WAGER_QUEUE = TEST_WAGER_QUEUE;
export const WAGER_DLQ = TEST_WAGER_DLQ;
export const EVENTS_QUEUE = TEST_EVENTS_QUEUE;

export const sqsClient = new SQSClient({
  endpoint: TEST_SQS_ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

let ensuredQueues: Promise<void> | undefined;

/**
 * Cria as filas desta execução (mesmos atributos do `infra/ministack/init-sqs.sh`): DLQ, depois a principal
 * com redrive após 5 recebimentos, depois a de eventos. Idempotente e memoizada por processo; recriar com
 * os mesmos atributos não falha.
 */
export function ensureTestQueues(): Promise<void> {
  ensuredQueues ??= createTestQueues();
  return ensuredQueues;
}

async function createTestQueues(): Promise<void> {
  const fifo = { FifoQueue: "true", ContentBasedDeduplication: "false" };
  await sqsClient.send(new CreateQueueCommand({ QueueName: WAGER_DLQ, Attributes: fifo }));
  const dlq = await sqsClient.send(new GetQueueAttributesCommand({ QueueUrl: await rawQueueUrl(WAGER_DLQ), AttributeNames: ["QueueArn"] }));
  await sqsClient.send(
    new CreateQueueCommand({
      QueueName: WAGER_QUEUE,
      Attributes: {
        ...fifo,
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.Attributes!["QueueArn"], maxReceiveCount: 5 }),
      },
    }),
  );
  await sqsClient.send(new CreateQueueCommand({ QueueName: EVENTS_QUEUE, Attributes: fifo }));
}

async function rawQueueUrl(name: string): Promise<string> {
  return (await sqsClient.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
}

const urls = new Map<string, string>();
export async function queueUrl(name: string): Promise<string> {
  await ensureTestQueues();
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
 * Esvazia as filas de teste lendo e apagando o que está visível, e espera as mensagens em voo (recebidas e
 * não apagadas, por exemplo por um processo morto) reaparecerem pelo visibility timeout para apagá-las
 * também. Sem essa espera, uma mensagem em voo de uma execução anterior reaparece no meio de outro teste e
 * conta em `queueDepth`. Não usa PurgeQueue: o SQS (e o MiniStack) podem descartar mensagens enviadas até
 * 60 s depois de um purge, o que apagaria mensagens de testes seguintes.
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

/** Maior visibility timeout em uso nos testes (30 s do consumidor) mais folga. */
const DRAIN_TIMEOUT_MS = 45_000;

async function drain(queue: string): Promise<void> {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  for (;;) {
    await receiveAll(queue, 0);
    const remaining = await queueDepth(queue);
    if (remaining === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`queue ${queue} still has ${remaining} in-flight or delayed message(s) after ${DRAIN_TIMEOUT_MS} ms`);
    }
    await Bun.sleep(500);
  }
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
