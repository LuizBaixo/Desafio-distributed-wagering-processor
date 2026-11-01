import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageBatchCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { TransientInfrastructureError } from "../../application/errors";
import type { BatchEntry, BatchResult, QueueMessage, QueuePort, SendOptions } from "../../application/ports/queue";

export interface SqsQueueOptions {
  endpoint: string;
  region: string;
  /** Fila usada por `ping()` (a principal). */
  pingQueue: string;
  /** `VisibilityTimeout` pedido em cada ReceiveMessage; sem valor, vale o da fila. */
  visibilityTimeoutSeconds?: number;
}

const TRACEPARENT_ATTRIBUTE = "traceparent";
const MAX_BATCH_ENTRIES = 10;
const MAX_BODY_BYTES = 262_144;

/** Adaptador SQS da porta de fila. Resolve e guarda em cache a URL de cada fila por nome. */
export class SqsQueue implements QueuePort {
  private readonly client: SQSClient;
  private readonly urls = new Map<string, Promise<string>>();

  constructor(private readonly opts: SqsQueueOptions) {
    this.client = new SQSClient({
      endpoint: opts.endpoint,
      region: opts.region,
      maxAttempts: 2,
    });
  }

  async receive(queue: string, max: number, waitSeconds: number): Promise<QueueMessage[]> {
    const QueueUrl = await this.url(queue);
    try {
      const res = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl,
          MaxNumberOfMessages: max,
          WaitTimeSeconds: waitSeconds,
          ...(this.opts.visibilityTimeoutSeconds !== undefined
            ? { VisibilityTimeout: this.opts.visibilityTimeoutSeconds }
            : {}),
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          MessageAttributeNames: [TRACEPARENT_ATTRIBUTE],
        }),
      );
      return (res.Messages ?? []).map((m) => {
        const traceparent = m.MessageAttributes?.[TRACEPARENT_ATTRIBUTE]?.StringValue;
        return {
          body: m.Body ?? "",
          receiptHandle: m.ReceiptHandle ?? "",
          messageId: m.MessageId ?? "",
          receiveCount: Number(m.Attributes?.["ApproximateReceiveCount"] ?? 1),
          ...(traceparent ? { attributes: { [TRACEPARENT_ATTRIBUTE]: traceparent } } : {}),
        };
      });
    } catch (e) {
      throw wrap(e);
    }
  }

  async delete(queue: string, receiptHandle: string): Promise<void> {
    const QueueUrl = await this.url(queue);
    await this.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: receiptHandle })).catch(rethrow);
  }

  async changeVisibility(queue: string, receiptHandle: string, seconds: number): Promise<void> {
    const QueueUrl = await this.url(queue);
    await this.client
      .send(new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }))
      .catch(rethrow);
  }

  async send(queue: string, body: string, opts: SendOptions): Promise<void> {
    const QueueUrl = await this.url(queue);
    await this.client
      .send(
        new SendMessageCommand({
          QueueUrl,
          MessageBody: body,
          MessageGroupId: opts.groupId,
          MessageDeduplicationId: opts.dedupId,
          ...(opts.attributes && Object.keys(opts.attributes).length > 0
            ? {
                MessageAttributes: Object.fromEntries(
                  Object.entries(opts.attributes).map(([k, v]) => [k, { DataType: "String", StringValue: v }]),
                ),
              }
            : {}),
        }),
      )
      .catch(rethrow);
  }

  async sendBatch(queue: string, entries: BatchEntry[]): Promise<BatchResult> {
    if (entries.length > MAX_BATCH_ENTRIES) {
      throw new Error(`sendBatch accepts at most ${MAX_BATCH_ENTRIES} entries, got ${entries.length}`);
    }
    const ok: string[] = [];
    const failed: BatchResult["failed"] = [];
    const sendable: Array<{ index: number; entry: BatchEntry }> = [];
    entries.forEach((entry, index) => {
      if (Buffer.byteLength(entry.body, "utf8") > MAX_BODY_BYTES) failed.push({ id: entry.id, code: "BODY_TOO_LARGE" });
      else sendable.push({ index, entry });
    });
    if (sendable.length === 0) return { ok, failed };
    // O SQS recusa o lote inteiro quando a soma dos corpos passa de 256 KiB; quem chama divide por bytes.
    const totalBytes = sendable.reduce((sum, { entry }) => sum + Buffer.byteLength(entry.body, "utf8"), 0);
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error(`sendBatch bodies total ${totalBytes} bytes, limit is ${MAX_BODY_BYTES}`);
    }

    const QueueUrl = await this.url(queue);
    const res = await this.client
      .send(
        new SendMessageBatchCommand({
          QueueUrl,
          Entries: sendable.map(({ index, entry }) => ({
            Id: String(index),
            MessageBody: entry.body,
            MessageGroupId: entry.groupId,
            MessageDeduplicationId: entry.dedupId,
            ...(entry.attributes && Object.keys(entry.attributes).length > 0
              ? {
                  MessageAttributes: Object.fromEntries(
                    Object.entries(entry.attributes).map(([k, v]) => [k, { DataType: "String", StringValue: v }]),
                  ),
                }
              : {}),
          })),
        }),
      )
      .catch(rethrow);

    const failedIndexes = new Map((res.Failed ?? []).map((f) => [f.Id ?? "", f.Code ?? "UNKNOWN"]));
    for (const { index, entry } of sendable) {
      const code = failedIndexes.get(String(index));
      if (code === undefined) ok.push(entry.id);
      else failed.push({ id: entry.id, code });
    }
    return { ok, failed };
  }

  async ping(): Promise<void> {
    const QueueUrl = await this.url(this.opts.pingQueue);
    await this.client
      .send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }))
      .catch(rethrow);
  }

  /** Fecha o cliente por último no shutdown, depois dos ganchos beforeApplicationShutdown dos consumidores. */
  onApplicationShutdown(): void {
    this.client.destroy();
  }

  private url(queue: string): Promise<string> {
    let cached = this.urls.get(queue);
    if (!cached) {
      cached = this.client
        .send(new GetQueueUrlCommand({ QueueName: queue }))
        .then((r) => {
          if (!r.QueueUrl) throw new Error(`queue ${queue} has no url`);
          return r.QueueUrl;
        })
        .catch((e: unknown) => {
          this.urls.delete(queue); // não guardar falha
          throw wrap(e);
        });
      this.urls.set(queue, cached);
    }
    return cached;
  }
}

function wrap(e: unknown): Error {
  if (e instanceof TransientInfrastructureError) return e;
  const err = e instanceof Error ? e : new Error(String(e));
  return new TransientInfrastructureError(`sqs unavailable: ${err.message}`);
}

function rethrow(e: unknown): never {
  throw wrap(e);
}
