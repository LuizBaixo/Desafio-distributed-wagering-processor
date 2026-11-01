import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { TEST_DATABASE_URL, TEST_SQS_ENDPOINT } from "../helpers/env";

const sqs = new SQSClient({
  endpoint: TEST_SQS_ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

const QUEUES = ["wager-transactions.fifo", "wager-transactions-dlq.fifo", "wallet-events.fifo"];

describe("infra smoke", () => {
  test("PostgreSQL responde SELECT 1", async () => {
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const result = await client.query<{ one: number }>("SELECT 1 AS one");
      expect(result.rows[0]?.one).toBe(1);
    } finally {
      await client.end();
    }
  });

  for (const name of QUEUES) {
    test(`GetQueueUrl resolve ${name}`, async () => {
      const out = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
      expect(out.QueueUrl).toBeDefined();
    });
  }

  test("fila principal tem RedrivePolicy com maxReceiveCount 5", async () => {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: "wager-transactions.fifo" }));
    const out = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["RedrivePolicy"] }),
    );
    const policy = JSON.parse(out.Attributes?.RedrivePolicy ?? "{}") as {
      maxReceiveCount?: number | string;
      deadLetterTargetArn?: string;
    };
    expect(Number(policy.maxReceiveCount)).toBe(5);
    expect(policy.deadLetterTargetArn).toContain("wager-transactions-dlq.fifo");
  });
});
