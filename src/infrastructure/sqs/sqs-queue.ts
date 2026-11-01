import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { TransientInfrastructureError } from "../../application/errors";
import type { QueueMessage, QueuePort, SendOptions } from "../../application/ports/queue";

export interface SqsQueueOptions {
  endpoint: string;
  region: string;
  /** Fila usada por `ping()` (a principal). */
  pingQueue: string;
  /** `VisibilityTimeout` pedido em cada ReceiveMessage; sem valor, vale o da fila. */
  visibilityTimeoutSeconds?: number;
}

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
        }),
      );
      return (res.Messages ?? []).map((m) => ({
        body: m.Body ?? "",
        receiptHandle: m.ReceiptHandle ?? "",
        messageId: m.MessageId ?? "",
        receiveCount: Number(m.Attributes?.["ApproximateReceiveCount"] ?? 1),
      }));
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
