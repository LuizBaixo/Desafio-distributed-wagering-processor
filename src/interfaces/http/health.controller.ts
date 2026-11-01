import { Controller, Get, Inject, type OnModuleDestroy } from "@nestjs/common";
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Pool } from "pg";
import { APP_CONFIG, type AppConfig } from "../../config/config";
import { TransientInfrastructureError } from "../../application/errors";

/**
 * Liveness: processo vivo. Readiness: ping simples em PostgreSQL (SELECT 1) e SQS (GetQueueAttributes).
 * A Tarefa 13 troca o ping direto pelas portas.
 */
@Controller("health")
export class HealthController implements OnModuleDestroy {
  private readonly pool: Pool;
  private readonly sqs: SQSClient;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 1,
      connectionTimeoutMillis: 2000,
    });
    this.sqs = new SQSClient({
      endpoint: config.sqsEndpoint,
      region: config.awsRegion,
      maxAttempts: 1,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
    this.sqs.destroy();
  }

  @Get("live")
  live(): { status: string } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<{ status: string }> {
    const db = await this.pingDb();
    const sqs = await this.pingSqs();
    if (db !== "ok" || sqs !== "ok") {
      throw new TransientInfrastructureError(`not ready: db=${db} sqs=${sqs}`);
    }
    return { status: "ok" };
  }

  private async pingDb(): Promise<"ok" | "down"> {
    try {
      await this.pool.query("SELECT 1");
      return "ok";
    } catch {
      return "down";
    }
  }

  private async pingSqs(): Promise<"ok" | "down"> {
    try {
      const { QueueUrl } = await this.sqs.send(
        new GetQueueUrlCommand({ QueueName: this.config.queues.wager }),
      );
      await this.sqs.send(
        new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }),
      );
      return "ok";
    } catch {
      return "down";
    }
  }
}
